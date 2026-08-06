# NAF.A — Agent Fleet Foundation — Implementation Plan

> **STATUS: APPROVED 2026-08-06 with four operator amendments (D2 zod statement, D5 charterVersion confirmation, D7 ceiling $2.00, D12 dual-shape note) — implementation in progress, Phase A only.**
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
> **Spec:** `docs/AGENT_FLEET.md` (canonical and sole copy; the interim duplicate `docs/NEXUS-AGENT-FLEET-MASTER-BRIEF.md` was deleted per operator 2026-08-06) Parts 0–5 + Part 12 § PHASE A. Prior reading done: `docs/AGENT_CONTROL_PLANE.md`, `docs/2026-08-03-ads-autonomy-domination-adx.md`, `docs/2026-08-05-ads-control-room-coverage-acr.md`.
> **Re-verified 2026-08-06 (second session):** all four predecessor docs re-read; every load-bearing repo claim below re-checked against the working tree (shared-package layout D1, zod versions D2, `/api/agent/` RBAC mapping D4, `AgentRun.agentKey` semantics D5, vitest suffix rule, tool-policy/automation-state idioms, `AI_FEATURES` write-gating D9, CronRun shape D10, `getEngineLevers` D11). One correction: the deploy migration runner is `packages/database/scripts/migrate-direct.mjs`, invoked by `railway.toml` `startCommand` (not repo-root `scripts/`).

**Goal:** The dark foundation of the Nexus Agent Fleet: nine additive Prisma models, shared Zod contracts, a charter registry (code-truth ⊕ DB-policy), an observation builder with TTL caching, a schema-validating agent executor, a DAG orchestrator with budget/halt short-circuits, and read-only routes — proven end-to-end by one trivial `fleet-selftest` charter producing a validated `AgentFinding` from a real observation. Zero behaviour change anywhere; everything ships `enabled=false`.

**Architecture:** Additive only. The fleet is a new `apps/api/src/services/agent-fleet/` module that *reads* the existing substrate and *reuses* the existing governance verbatim: `AutonomyLevel` from `ads-autonomy.ts` (no fourth vocabulary), the code⊕DB merge idiom from `tool-policy.service.ts`, the AgentRun create-first/update-twice audit pattern from `agent-runtime.service.ts`, model routing via `model-resolver.service.ts` + `logUsage`, and RBAC by mounting under the already-mapped `/api/agent/` prefix. No changes to `ads-write-gate.ts`, `approval-gate.service.ts`, or `tool-policy.service.ts` (Phase A performs no mutations at all — findings only).

**Tech Stack:** TypeScript ESM (`.js` relative imports — load-bearing at runtime), Fastify plugin routes, Prisma (hand-authored migration folder), Zod **v4** in `@nexus/shared` (new dep, matching web's `zod@^4.3.6`), Vitest (`*.vitest.test.ts` suffix — plain `*.test.ts` is excluded by `apps/api/vitest.config.ts`), `TtlCache` from `utils/ttl-cache.ts`.

## Global Constraints

- **Additive schema only.** One hand-authored migration folder `packages/database/prisma/migrations/20260806<letter>_nafa_agent_fleet/` committed **with** `schema.prisma` (DEVELOPMENT.md rule; pre-push runs both drift scripts). Letter chosen at implementation time — concurrent sessions also mint `20260806*` folders.
- **No existing signature changes.** The only touched existing files: `schema.prisma` (append), `apps/api/src/index.ts` (import + `app.register`), `apps/api/src/services/ai/ai-features.ts` (append 5 feature keys to the `AI_FEATURES` const — data, not signature), `packages/shared/package.json` (new subpath export + deps).
- **Ships dark.** `AgentCharter.enabled` defaults `false`; the orchestrator is **not** scheduled (no cron in Phase A); routes are read-only except the fleet halt toggle, charter seed, and one manual run trigger (mirrors the existing autonomous-agent "run now", which deliberately ignores `enabled`).
- **Fail-safe defaults.** DB-unreadable ⇒ charter resolves `OFF` (code default is the floor, unlike tool-policy where code default is `enabled=true` — inverted deliberately). Kill switch (`NEXUS_AI_KILL_SWITCH` via `isAiKillSwitchOn()`) and `AgentFleetState.halted` are checked by the orchestrator **and** the executor.
- **`apps/api` tsconfig is NOT strict** — `tsc` will not catch null-into-non-nullable. Null-safety is verified by tests and by dry-reading the migration SQL, not by the compiler.
- **Every write to `AgentRun` follows the house contract:** create-first (row exists before work), success-update and failure-update both set `latencyMs`/`endedAt`, failure update is `.catch(() => {})`-suppressed, functions return `{ ok: false, error }` rather than throwing.
- **Every model call goes through `getProviderForFeature` → `resolveModelForFeature` → `provider.generate` → `logUsage`** (the `aiDraft` recipe, `services/agents/tools/draft.tools.ts:15-45`). No direct SDK/fetch use (L9). No tool-calling in Phase A — `runToolLoop` is Anthropic-only raw-fetch and unneeded here; analysts get pre-gathered observations and answer with one JSON generation (`jsonMode: true`, tolerating markdown fences — the Anthropic provider only *asks* for bare JSON).
- **Commits:** per task, explicit paths (`git commit --only <paths>` — working tree carries unrelated WIP), message prefix `feat(naf):` / `test(naf):`.
- **Gates per task:** `npx tsc --noEmit` (in `apps/api`), `npx vitest run <new tests>`; per phase: `npm run check:drift`, `.githooks/pre-push` (includes RBAC coverage — satisfied by mounting under `/api/agent/`).

---

## Decisions made in this plan (call out if you disagree)

These resolve conflicts between the brief and verified repo reality. Each is the recommended option; alternatives noted.

| # | Decision | Rationale |
|---|---|---|
| D1 | **Contracts live at `packages/shared/agent-fleet.ts`** (flat file + `./agent-fleet` subpath export), not `packages/shared/src/agent-fleet/contracts.ts`. | `packages/shared` has **no `src/`**; tsconfig `include: ["*.ts"]` is a non-recursive top-level glob; exports are per-file subpaths to `dist/`. Following the brief literally means restructuring the package — not additive. |
| D2 | **Zod v4 (`^4.3.6`) added as a dependency of `@nexus/shared`**; contracts written in Zod-4 idiom (`z.record(z.string(), z.unknown())`, `z.iso.datetime()`). apps/api gets it transitively; web already has the same range. **Stated explicitly (operator amendment 2026-08-06): Phase A introduces zod into apps/api's dependency graph for the first time** — the API has never carried a runtime validation library, and the executor's L4 gate (validate before persist, retry once, never coerce) requires one. It arrives transitively via `@nexus/shared/agent-fleet` rather than as a direct apps/api dependency so there is exactly one zod version and one schema source shared by API and web. | apps/api has **no** validation library today; web has zod 4. One version across workspaces avoids dual-package hazards when web imports contracts in Phase D. The brief's snippets are Zod-3 idiom and are adapted, not copied. |
| D3 | **Vitest added to `packages/shared`** (devDep + `vitest.config.mts` + `"test": "vitest run"`), tests named `*.vitest.test.ts`, with `"exclude": ["*.vitest.test.ts"]` added to its tsconfig so tests don't compile into `dist/`. | Shared currently has no test harness (one legacy tsx-run test). Testing contracts from apps/api would test compiled `dist/`, not source — wrong feedback loop for TDD. The tsconfig `exclude` is additive (nothing matches it today). |
| D4 | **Routes mount under `/api/agent/fleet/*`**, not `/api/agent-fleet/*`. | `permissions-manifest.ts:141` already maps `pfx('/api/agent/')` → `ai.view`/`ai.run`. The hyphenated prefix would **not** match, would 403 in enforce mode, and would fail the pre-push RBAC coverage check without a new manifest entry. Zero-manifest-change wins. |
| D5 | **Reuse `AgentRun.agentKey` as the charter key; do not add a `charterKey` column.** Add only `charterVersion`, `mode`, `parentRunId`, `orchestrationId`, `findingCount`, `haltedReason`. **Confirmed (operator 2026-08-06): `AgentRun.charterVersion` IS retained** — charter-version attribution on every run is load-bearing for the Phase E promotion ladder (a scorecard delta must bind to the charter version that produced it). Only the redundant *key* column is dropped, never the version. | `agentKey` is already "stable kebab-case id, denormalized to survive definition deletion" — the identical concept. Two columns carrying the same value is drift waiting to happen; existing run-history queries keep working. `AgentFinding.charterKey` stays as specced (findings have no legacy column). |
| D6 | **`AgentExemplar` ships WITHOUT the `embedding` column.** | Schema has no `previewFeatures`/`postgresqlExtensions` and Neon's pgvector status is unverified. The brief itself marks it "only if pgvector present". Adding it later (Phase E) is an additive column + extension enablement, decided when exemplar retrieval is actually built. |
| D7 | **`AgentFleetState` defined here** (the brief references it but never defines it): singleton row id `'singleton'`, `halted`/`haltedAt`/`haltReason`/`haltedBy`, `dailyCeilingUSD` default **2.00** (operator decision 2026-08-06 — the proposed 5.00 was rejected), `updatedAt`. Read through an upsert-on-read helper that reports `degraded` when the row can't be read (the `ads-automation-state.service.ts` idiom), failing safe to halted-posture. | Mirrors the proven ACR pattern. **$2.00/day holds through Phase C; revisit at Phase G** when the full fleet's council cadence makes the €60/month target measurable against real spend. |
| D8 | **Autonomy vocabulary: import `AutonomyLevel`/`isAutonomyLevel` from `services/advertising/ads-autonomy.ts`.** `AgentCharter.autonomyLevel/autonomyCap` use `OFF|OBSERVE|PROPOSE|AUTO`. `AgentDefinition.autonomyTier` (`suggest|low|medium|high`) is untouched — it governs the old ACP copilot layer, not the fleet. | ACR names "two autonomy vocabularies" as a defect; there are already three. Reusing the ads dial verbatim (L5, brief anti-goal #5) adds zero new ones. The pure module has no ads coupling. |
| D9 | **Five AI feature keys appended to `AI_FEATURES`:** `agent-fleet-analyst`, `agent-fleet-director`, `agent-fleet-critic`, `agent-fleet-strategist`, `agent-fleet-auditor` (one per tier, brief 9.2 §8). | Without registration a key is invisible in Settings→Models and `isWritableFeatureKey()` refuses overrides — the exact `'products-copilot'` trap already live in the ACP layer. Registered keys make tier-level model routing a one-row operator change. Current Anthropic default resolves to Haiku 4.5 — right cost class for a selftest analyst. |
| D10 | **Selftest observation = cron health** (`CronRun` failures + stale jobs, last 24h). Finding kind `cron_failing` / `cron_stale`, entityType `COMPONENT`. | Real data, read-only, marketplace-independent, always non-empty in practice, zero ads coupling — and genuinely useful output for a smoke test. Alternatives (data-vintage summary, ads pipeline health) are fine but ads-coupled. |
| D11 | **Fleet lever-registry registration in `getEngineLevers()` is DEFERRED to Phase D** and recorded as an obligation there (with a `haltBehaviour` declaration per ACR: the orchestrator is `'honours'`). | ACR's "register in `getEngineLevers()` and nowhere else" applies to engines visible in the ads Control Room. Phase A is dark and unscheduled; adding a lever row now would advertise a machine that never runs. |
| D12 | **`AgentStep` is the fleet's step trace; `AgentRun.steps` Json stays null for fleet runs.** **Operator amendment 2026-08-06: the existing `AgentRun.steps` writers (`agent-runtime.service.ts`, `tool-loop.service.ts`, the autonomous agents) are untouched in Phase A** — ACP copilot runs keep writing the Json blob exactly as today. **Phase D's run timeline must therefore read both shapes**: `AgentStep` rows for fleet runs, the `steps` Json for legacy/copilot runs — recorded here as a Phase D obligation. | The brief (L6) wants normalized, OTel-shaped steps with per-step cost — the Json blob can't be indexed or summed. Divergence from the ACP runtime is deliberate and documented here. |

## Open questions — ALL RESOLVED by operator 2026-08-06

1. **Fleet daily ceiling** — ~~$5.00/day default~~ **rejected: $2.00/day through Phase C, revisit at Phase G** (see D7).
2. **`fleet-selftest` verification venue** — **prod Railway** via the manual-run route, charter still `enabled=false` (matches `docs/AGENT_CONTROL_PLANE.md` §6: everything ships dark and is turned on per-phase after testing on prod).
3. **Selftest model** — **Haiku 4.5 via Anthropic**, by default resolution; no `AiFeatureModelPref` pin.
4. **Commit cadence** — **per-task local commits, batch push on operator command.**
5. **Docs** — brief + plan committed (`26b5f8dda`, `e884aa0d9`); **`docs/AGENT_FLEET.md` is canonical and the duplicate `NEXUS-AGENT-FLEET-MASTER-BRIEF.md` is deleted.**

---

## File Structure

| File | Responsibility |
|------|----------------|
| `packages/database/prisma/schema.prisma` (modify — append NAF section) | 9 new models + 6 new nullable/defaulted `AgentRun` columns. |
| `packages/database/prisma/migrations/20260806<letter>_nafa_agent_fleet/migration.sql` (create) | Hand-authored DDL matching the schema exactly (column-drift gate). |
| `packages/shared/agent-fleet.ts` (create) | All Zod-4 contracts (Part 5) + `OUTPUT_SCHEMAS` registry keyed by `outputSchemaKey` + inferred TS types. |
| `packages/shared/agent-fleet.vitest.test.ts` (create) | Contract unit tests (valid/invalid fixtures per schema). |
| `packages/shared/vitest.config.mts` (create) | Minimal vitest config, include `*.vitest.test.ts`. |
| `packages/shared/package.json` (modify) | `./agent-fleet` subpath export; deps `zod@^4.3.6`; devDeps `vitest`; `test` script. |
| `packages/shared/tsconfig.json` (modify) | Add `"exclude": ["*.vitest.test.ts"]`. |
| `apps/api/src/services/agent-fleet/charter-types.ts` (create) | `CharterDefinition`, `EffectiveCharter` (code shape; autonomy types imported from `ads-autonomy.js`). |
| `apps/api/src/services/agent-fleet/charters/fleet-selftest.charter.ts` (create) | The one Phase A charter: tier `analyst`, domain `ops`, `observationKeys: ['cron-health']`, `outputSchemaKey: 'analyst-output'`, `modelFeature: 'agent-fleet-analyst'`, `autonomyCap: 'OBSERVE'`. |
| `apps/api/src/services/agent-fleet/charter-registry.ts` (create) | Code-truth charter map + DB override merge (TtlCache 60s, degrade→OFF), `resolveCharter`, `listCharters`, `seedCharters` (create-if-absent), `bustCharterCache`. |
| `apps/api/src/services/agent-fleet/observation-builder.ts` (create) | Builder registry; `getObservation(key, scope)` — fresh-row read from `AgentObservation` else compute + upsert with TTL. |
| `apps/api/src/services/agent-fleet/observations/cron-health.observation.ts` (create) | The selftest evidence builder over `CronRun` (failures/stale, last 24h; TTL 30 min). |
| `apps/api/src/services/agent-fleet/budget-guard.ts` (create) | Pure `checkRunBudget` (tokens/tool-calls, mid-run) + DB-backed `checkCharterDayBudget`, `checkFleetDayBudget` (sum `AgentRun.costUSD` today), typed `BudgetVerdict`. |
| `apps/api/src/services/agent-fleet/tracing.ts` (create) | Pure OTel-GenAI attribute shaping + `recordStep()` appender onto `AgentStep` (monotonic `seq`). |
| `apps/api/src/services/agent-fleet/agent-executor.ts` (create) | `executeCharter(key, opts)`: resolve → observations → prompt → generate(jsonMode) → fence-strip/parse → Zod validate (retry once with error appended) → persist findings (dedupe upsert) + steps + run row. |
| `apps/api/src/services/agent-fleet/fleet-graph.ts` (create) | `FleetGraph` types + `FLEET_GRAPH` (Phase A: one node, no edges) + `topoLevels()` (cycle-detecting). |
| `apps/api/src/services/agent-fleet/orchestrator.ts` (create) | `runFleet(mode)`: walk levels, bounded concurrency (inline limiter, no new dep), halt/kill/budget short-circuit between agents, one `orchestrationId` threading. |
| `apps/api/src/services/agent-fleet/fleet-state.service.ts` (create) | `getFleetState()` (upsert-on-read, `degraded` flag), `haltFleet(reason, by)`, `resumeFleet(by)`. |
| `apps/api/src/routes/agent-fleet.routes.ts` (create) | Read-only `/agent/fleet/{charters,runs,findings,plans,graph,state}` + `POST state/halt`, `POST state/resume`, `POST charters/seed`, `POST run/:key`. |
| `apps/api/src/index.ts` (modify) | Import + `app.register(agentFleetRoutes, { prefix: '/api' })`. |
| `apps/api/src/services/ai/ai-features.ts` (modify) | Append the 5 `agent-fleet-*` feature keys. |
| co-located `*.vitest.test.ts` per module (create) | TDD tests; Prisma mocked via `vi.mock('../db.js', …)` relative to each module. |

---

### Task 1: prisma schema + migration (ships empty)

**Files:** modify `packages/database/prisma/schema.prisma` (append `/// NAF — Nexus Agent Fleet — docs/AGENT_FLEET.md` section); create `packages/database/prisma/migrations/20260806<letter>_nafa_agent_fleet/migration.sql`.
**Interfaces:** models `AgentCharter`, `AgentObservation`, `AgentFinding`, `AgentPlan`, `AgentStrategy`, `AgentStep`, `AgentExemplar` (no `embedding` — D6), `AgentScorecard`, `AgentFleetState` (D7) — fields exactly as brief Part 4 except: `AgentFinding.charterVersion Int` kept; **no** `GraphEdge` (Phase H); **no** `AgentRun.charterKey` (D5). `AgentRun` gains `charterVersion Int?`, `mode String?`, `parentRunId String?`, `orchestrationId String?`, `findingCount Int @default(0)`, `haltedReason String?`, `@@index([orchestrationId])`.

- [ ] **Step 1: schema** — append the NAF section; every new `AgentRun` column nullable or defaulted (table has rows on prod).
- [ ] **Step 2: hand-author migration.sql** — `CREATE TABLE` × 9, `ALTER TABLE "AgentRun" ADD COLUMN` × 6, indexes/uniques exactly as schema (`AgentFinding_dedupe` unique, `AgentObservation` scope unique, `AgentStep (agentRunId, seq)` unique, `AgentScorecard (charterKey, periodStart, periodEnd)` unique). Follow the ACP.0 migration (`20260617_acp0_control_plane/migration.sql`) as the style reference.
- [ ] **Step 3: verify parity** — `cd packages/database && npm run check:drift && npm run check:column-drift` → 0 drift (drift scripts diff schema vs migrations, not vs prod — safe locally).
- [ ] **Step 4: generate + typecheck** — `npx prisma generate`; `cd apps/api && npx tsc --noEmit` (proves no existing code breaks).
- [ ] **Step 5: commit** — `git commit --only packages/database/prisma/schema.prisma packages/database/prisma/migrations/20260806*_nafa_agent_fleet -m "feat(naf): NAF.A schema — 9 fleet models + AgentRun fleet columns, ships empty"`.

> **Implementer note:** deploy applies via `packages/database/scripts/migrate-direct.mjs` on next Railway start (`railway.toml` startCommand; strips `-pooler` itself). Do not run `prisma migrate dev` — the repo's folders are hand-authored and dev-migrate would try to reconcile 369 of them.

---

### Task 2: shared contracts (Zod 4)

**Files:** create `packages/shared/agent-fleet.ts`, `packages/shared/agent-fleet.vitest.test.ts`, `packages/shared/vitest.config.mts`; modify `packages/shared/package.json`, `packages/shared/tsconfig.json`.
**Interfaces:** `ExpectedEffect`, `Finding`, `AnalystOutput`, `PlanItem`, `DirectorOutput`, `CriticOutput` (brief Part 5, Zod-4 idiom — D2), plus:

```ts
export const OUTPUT_SCHEMAS = {
  'analyst-output': AnalystOutput,
  'director-output': DirectorOutput,
  'critic-output': CriticOutput,
} as const
export type OutputSchemaKey = keyof typeof OUTPUT_SCHEMAS
export type FindingT = z.infer<typeof Finding>   // + siblings
```

- [ ] **Step 1: failing test** (`agent-fleet.vitest.test.ts`) — per schema: one minimal valid fixture parses; `evidenceRefs: []` rejects (the "no evidence, no finding" floor); `confidence: 1.2` rejects; `rationale` shorter than 20 rejects; unknown `OUTPUT_SCHEMAS` key is a type error (compile-time assertion via `@ts-expect-error`).
- [ ] **Step 2: run, verify fail** — `cd packages/shared && npx vitest run agent-fleet.vitest.test.ts` → FAIL (module missing).
- [ ] **Step 3: implement** (`agent-fleet.ts`) — Zod-4 adaptations: `z.record(z.string(), z.unknown())`, `z.iso.datetime()` for `dataVintage`.
- [ ] **Step 4: package wiring** — `exports["./agent-fleet"]` → `dist/agent-fleet.{js,d.ts}`; deps `"zod": "^4.3.6"`; devDeps `"vitest"`; `"test": "vitest run"`; tsconfig `exclude`. `npm install` at root (lockfile updates — commit it).
- [ ] **Step 5: run, verify pass** + `npm run build` in `packages/shared` (dist emits, tests excluded).
- [ ] **Step 6: commit** — `feat(naf): NAF.A shared contracts — Zod 4 fleet artifact schemas + registry`.

---

### Task 3: charter types + registry + fleet-selftest charter

**Files:** create `charter-types.ts`, `charters/fleet-selftest.charter.ts`, `charter-registry.ts`, `charter-registry.vitest.test.ts` (all under `apps/api/src/services/agent-fleet/`).
**Interfaces:**

```ts
import type { AutonomyLevel } from '../advertising/ads-autonomy.js'   // D8 — reuse, never redeclare
export interface CharterDefinition { key; version; tier: 'analyst'|'director'|'strategist'|'critic'|'auditor';
  domain; name; description?; systemPrompt; outputSchemaKey: OutputSchemaKey; toolNames: string[];
  observationKeys: string[]; modelFeature: string; fallbackFeature?: string; autonomyCap: AutonomyLevel;
  cadence?: string; maxFindingsPerRun: number; maxToolCallsPerRun: number; maxTokensPerRun: number;
  dailyBudgetUSD: number; maxProposedValueCents?: number }
export interface EffectiveCharter extends CharterDefinition {
  enabled: boolean; autonomyLevel: AutonomyLevel;   // min(db, cap); db absent ⇒ 'OFF'
  scopeMarketplaces: string[]; scopePortfolioIds: string[]; scopeCampaignIds: string[]; degraded: boolean }
export function resolveCharter(key: string): Promise<EffectiveCharter | null>
export function listCharters(): Promise<EffectiveCharter[]>
export function seedCharters(): Promise<{ created: number }>
export function bustCharterCache(): void
```

Merge semantics (copy `tool-policy.service.ts:71-101` structurally, inverted floor): code map is the existence check; DB rows load as one bulk map behind `TtlCache({ ttlMs: 60_000, maxEntries: 1 })`; **DB read failure degrades to `enabled=false, autonomyLevel='OFF', degraded=true`** (fleet stops when policy is unreadable — opposite of tool-policy's default-open, deliberate); `autonomyLevel = min(dbLevel, autonomyCap)` by `AUTONOMY_LEVELS` index, garbage DB strings fall to `'OFF'` via `isAutonomyLevel`; DB may **lower** but never raise budget/caps. `seedCharters` is create-if-absent on `(key, version)` — never clobbers operator edits.

- [ ] **Step 1: failing test** — cases: unknown key → null; no DB row → OFF/disabled; DB `AUTO` with cap `OBSERVE` → `OBSERVE`; DB error (mock rejects) → degraded OFF; seed twice → second `{ created: 0 }`. Mock via `vi.mock('../../db.js', () => ({ default: { agentCharter: { findMany: vi.fn(), … } } }))` hoisted before import.
- [ ] **Step 2: run, verify fail** — `cd apps/api && npx vitest run src/services/agent-fleet/charter-registry.vitest.test.ts` → FAIL.
- [ ] **Step 3: implement** — including `fleet-selftest.charter.ts`: `autonomyCap: 'OBSERVE'`, `maxTokensPerRun: 20_000`, `dailyBudgetUSD: 0.25`, `maxFindingsPerRun: 10`, `toolNames: []`, systemPrompt framing it as an ops analyst reading cron-health evidence and emitting `AnalystOutput` findings of kind `cron_failing`/`cron_stale`.
- [ ] **Step 4: run, verify pass.**
- [ ] **Step 5: typecheck + commit** — `feat(naf): NAF.A charter registry — code truth, DB policy, fail-safe OFF`.

---

### Task 4: observation builder + cron-health builder

**Files:** create `observation-builder.ts`, `observations/cron-health.observation.ts`, tests for both.
**Interfaces:**

```ts
export interface ObservationScope { entityType?: string; entityId?: string; marketplace?: string }
export interface ObservationResult { key: string; payload: unknown; dataVintage: Date; computedAt: Date; cached: boolean }
export interface ObservationBuilder { key: string; ttlMinutes: number;
  build(scope: ObservationScope): Promise<{ payload: unknown; dataVintage: Date }> }
export function getObservation(key: string, scope?: ObservationScope): Promise<ObservationResult>
```

`getObservation`: look up builder in a frozen const registry (tool-registry idiom) → read `AgentObservation` by the scope unique; if `expiresAt > now` return cached → else `build()`, upsert with `expiresAt = now + ttl`, return fresh. Twenty agents reading the same evidence trigger one computation (brief 9.2 §4). `cron-health` builder: `CronRun` groupBy jobName over last 24h → `{ jobs: [{ jobName, runs, failures, lastStatus, lastRunAt, staleHours }] }`, `dataVintage = now` (live DB), TTL 30.

- [ ] **Step 1: failing test** — unknown key throws typed error; fresh row short-circuits `build` (spy not called); expired row recomputes + upserts; cron-health shapes a fixture of mocked `CronRun` rows correctly (failure counting, staleness math).
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement.**
- [ ] **Step 4: run, verify pass.**
- [ ] **Step 5: typecheck + commit** — `feat(naf): NAF.A observation builder — TTL-cached deterministic evidence`.

---

### Task 5: budget guard

**Files:** create `budget-guard.ts` + test.
**Interfaces:**

```ts
export type BudgetVerdict = { ok: true } | { ok: false; reason: 'tokens' | 'tool_calls' | 'charter_day' | 'fleet_day'; detail: string }
export function checkRunBudget(used: { tokens: number; toolCalls: number },
                               caps: { maxTokensPerRun: number; maxToolCallsPerRun: number }): BudgetVerdict   // pure
export function checkCharterDayBudget(charterKey: string, dailyBudgetUSD: number): Promise<BudgetVerdict>       // sums today's AgentRun.costUSD by agentKey
export function checkFleetDayBudget(ceilingUSD: number): Promise<BudgetVerdict>                                 // sums today's fleet AgentRun.costUSD (mode NOT NULL)
```

"Today" = UTC day bounds (mind the `AT TIME ZONE` trap — compute bounds in JS, pass Dates to Prisma). DB failure in the day-checks returns `{ ok: false, reason: …, detail: 'unreadable' }` — **fail closed**; this is the enforcement `AgentTool.dailyBudgetUSD` never got, so nothing existing is reusable here.

- [ ] **Step 1: failing test** — pure caps at/over boundary; day-budget over/under with mocked aggregate; DB rejection → fail closed. **Acceptance-critical case:** a simulated run loop calling `checkRunBudget` after each step aborts mid-run when cumulative tokens cross the cap (this is the "budget abort demonstrably fires mid-run" test).
- [ ] **Step 2: run, verify fail.** — [ ] **Step 3: implement.** — [ ] **Step 4: run, verify pass.**
- [ ] **Step 5: typecheck + commit** — `feat(naf): NAF.A budget guard — per-run, per-charter-day, per-fleet-day, fail-closed`.

---

### Task 6: fleet state + tracing

**Files:** create `fleet-state.service.ts`, `tracing.ts`, tests.
**Interfaces:**

```ts
// fleet-state — ads-automation-state idiom (upsert-on-read singleton, degraded flag, fail-safe halted)
export interface FleetStateView { halted: boolean; haltedAt: Date|null; haltReason: string|null; haltedBy: string|null;
  dailyCeilingUSD: number; degraded: boolean }
export function getFleetState(): Promise<FleetStateView>          // DB unreadable ⇒ { halted: true, degraded: true, … }
export function haltFleet(reason: string, by?: string|null): Promise<FleetStateView>
export function resumeFleet(by?: string|null): Promise<FleetStateView>

// tracing — pure shaping + one appender
export interface StepInput { agentRunId: string; seq: number; type: 'observation'|'model'|'validation'|'gate';
  name: string; input?: unknown; output?: unknown; inputTokens?: number; outputTokens?: number;
  costUSD?: number; latencyMs?: number; ok?: boolean; errorMessage?: string }
export function otelAttributes(charter: { key; version; modelFeature }, step: StepInput): Record<string, unknown>
  // gen_ai.agent.name, gen_ai.operation.name, gen_ai.usage.{input,output}_tokens, naf.charter_key, naf.charter_version, naf.orchestration_id
export function recordStep(step: StepInput): Promise<void>        // .catch-suppressed — a trace write must never fail a run
```

- [ ] **Step 1: failing tests** (both modules) — fleet-state: unhalted default on empty DB; halt sets/resume clears; unreadable DB → `halted: true, degraded: true`. tracing: attribute shaping golden-object; `recordStep` swallows a rejecting create.
- [ ] **Step 2–4: red → implement → green.**
- [ ] **Step 5: typecheck + commit** — `feat(naf): NAF.A fleet state (fail-safe halt) + OTel step tracing`.

---

### Task 7: agent executor

**Files:** create `agent-executor.ts` + test.
**Interfaces:**

```ts
export interface ExecuteOptions { trigger: 'manual'|'schedule'; mode: 'tick'|'sweep'|'council'|'summit'|'incident'|'ask';
  orchestrationId?: string; userId?: string|null; ignoreEnabled?: boolean }   // ignoreEnabled: manual run-now only
export interface ExecuteResult { runId: string; ok: boolean; findingCount?: number; costUSD?: number;
  haltedReason?: string; error?: string }
export function executeCharter(key: string, opts: ExecuteOptions): Promise<ExecuteResult>
```

Pipeline (each stage a `recordStep`): resolve charter (OFF and not `ignoreEnabled` ⇒ no-op result, no run row) → kill switch + fleet halt + `checkCharterDayBudget`/`checkFleetDayBudget` (denied ⇒ create run with `haltedReason`, status `done`, `ok: false`) → **create AgentRun first** (`agentKey`, `charterVersion`, `mode`, `orchestrationId`, `trigger`, `status: 'running'`) → gather observations (loop `observationKeys`) → assemble prompt (systemPrompt + observation payloads as fenced JSON + output contract instruction naming the Zod shape) → `getProviderForFeature(charter.modelFeature)` / fall back to `fallbackFeature` / error out → `resolveModelForFeature` → `provider.generate({ prompt, model, feature, jsonMode: true, maxOutputTokens: derived from maxTokensPerRun })` → `logUsage` (the non-optional convention) → strip markdown fences → `JSON.parse` → `OUTPUT_SCHEMAS[charter.outputSchemaKey].safeParse`; on failure **retry once** with the Zod error appended to the prompt, then fail the run (never coerce, never partially accept — brief Part 5) → persist findings via dedupe-aware upsert on `(charterKey, entityType, entityId, dedupeKey)` refreshing `observation/confidence/expiresAt`, capped at `maxFindingsPerRun` (excess dropped + noted in run output) → success-update run (`findingCount`, tokens, `costUSD`, `model`, `provider`, `latencyMs`, `endedAt`); failure path mirrors the house `.catch(() => {})` contract.

- [ ] **Step 1: failing test** — mock `db.js`, `model-resolver.service.js` (fake provider returning canned JSON), `usage-logger.service.js`. Cases: happy path persists N findings + steps + success run-update; fenced ` ```json ` reply parses; first invalid → retry with error in prompt → valid succeeds; twice invalid → run failed, zero findings (nothing enters the blackboard); day-budget denial → run row with `haltedReason`, provider never called; `OFF` + no `ignoreEnabled` → no run row; dedupe collision updates rather than duplicates.
- [ ] **Step 2–4: red → implement → green.**
- [ ] **Step 5: typecheck + commit** — `feat(naf): NAF.A executor — observe, generate, validate, persist; schema failure enters nothing`.

---

### Task 8: fleet graph + orchestrator

**Files:** create `fleet-graph.ts`, `orchestrator.ts`, tests.
**Interfaces:**

```ts
export interface FleetNode { key: string; tier: CharterDefinition['tier'] }
export interface FleetEdge { from: string; to: string; artifact: 'finding'|'plan'|'strategy' }
export interface FleetGraph { nodes: FleetNode[]; edges: FleetEdge[] }
export const FLEET_GRAPH: FleetGraph            // Phase A: [{ key: 'fleet-selftest', tier: 'analyst' }], []
export function topoLevels(g: FleetGraph): string[][]    // pure; throws TypedError on cycle / unknown edge endpoint

export interface FleetRunResult { orchestrationId: string; started: number; succeeded: number; failed: number;
  skipped: number; haltedReason?: string }
export function runFleet(mode: 'sweep'|'council', opts?: { concurrency?: number }): Promise<FleetRunResult>
```

`runFleet`: mint `orchestrationId` (cuid) → level by level, inline concurrency limiter (default 3, no new dep) → **before each agent**: `isAiKillSwitchOn()` / `getFleetState().halted` / `checkFleetDayBudget` — any trip short-circuits the remainder (`skipped` counted, `haltedReason` set) → each agent via `executeCharter(key, { trigger: 'schedule', mode, orchestrationId })` — disabled charters no-op (that's the dark ship). An agent failure never stops siblings (L3: the orchestrator is the only thing that starts agents; nothing recursive).

- [ ] **Step 1: failing test** — `topoLevels`: chain → levels, diamond → parallel level, cycle throws; `runFleet` (executor mocked): concurrency bound respected (max in-flight counter), halt mid-fleet skips the rest, disabled charters counted `skipped`, one failing agent doesn't fail the fleet.
- [ ] **Step 2–4: red → implement → green.**
- [ ] **Step 5: typecheck + commit** — `feat(naf): NAF.A fleet graph + orchestrator — bounded, halt-aware, non-recursive`.

---

### Task 9: routes + wiring + feature keys

**Files:** create `apps/api/src/routes/agent-fleet.routes.ts`; modify `apps/api/src/index.ts`, `apps/api/src/services/ai/ai-features.ts`.
**Interfaces:** `FastifyPluginAsync`, paths **without** `/api` prefix, mounted `app.register(agentFleetRoutes, { prefix: '/api' })`:

| Route | Behaviour |
|---|---|
| `GET /agent/fleet/charters` | `listCharters()` (merged, includes `degraded`) |
| `GET /agent/fleet/runs?charterKey=&mode=&limit=` | fleet runs (`mode NOT NULL`), desc, take ≤ 100 |
| `GET /agent/fleet/findings?status=&domain=&charterKey=` | findMany desc, take ≤ 200 |
| `GET /agent/fleet/plans` | findMany (empty until Phase C) |
| `GET /agent/fleet/graph` | `FLEET_GRAPH` + per-node effective autonomy/enabled |
| `GET /agent/fleet/state` | `getFleetState()` |
| `POST /agent/fleet/state/halt` `{ reason }` / `POST /agent/fleet/state/resume` | halt toggle |
| `POST /agent/fleet/charters/seed` | `seedCharters()` |
| `POST /agent/fleet/run/:key` | manual run-now: `executeCharter(key, { trigger: 'manual', mode: 'ask', ignoreEnabled: true })`; kill-switch → 503, unknown key → 404 (house error idiom) |

- [ ] **Step 1: implement routes** (thin — services carry the logic and tests; no route-level vitest, matching house practice).
- [ ] **Step 2: wire `index.ts`** — import + register beside `agentRoutes`.
- [ ] **Step 3: append feature keys** to `AI_FEATURES` (D9) — labels "Agent Fleet — Analyst tier" etc.
- [ ] **Step 4: RBAC coverage** — `npx tsx apps/api/src/scripts/check-rbac-coverage.ts` → passes via existing `pfx('/api/agent/')` mapping (D4); no manifest edit.
- [ ] **Step 5: typecheck + commit** — `feat(naf): NAF.A routes under /api/agent/fleet + tier feature keys`.

---

### Task 10: end-to-end selftest + phase gates

**Files:** none new (verification task).

- [ ] **Step 1: full suite** — `cd apps/api && npx vitest run src/services/agent-fleet` and `cd packages/shared && npm test` → green; `npx tsc --noEmit` clean in both.
- [ ] **Step 2: phase gates** — `npm run check:drift` (root), `npm run tokens:check` (no web changes — must stay green), `.githooks/pre-push` dry run.
- [ ] **Step 3: deploy + migrate** — push on operator's command (open question 4); Railway start applies the migration via `migrate-direct.mjs`; verify boot log + `railway` deploy status (crash-loop playbook is on record).
- [ ] **Step 4: live selftest** — `POST /api/agent/fleet/charters/seed`, then `POST /api/agent/fleet/run/fleet-selftest`; verify: one `AgentRun` (`mode='ask'`, tokens/cost set), ≥1 `AgentStep` per pipeline stage, ≥1 validated `AgentFinding` with `evidenceRefs` pointing at a real `AgentObservation` row, spend visible in `/settings/ai` usage (proves `logUsage`), everything else untouched (`enabled=false` everywhere, no cron registered).
- [ ] **Step 5: acceptance write-up** — append a dated verification section to this doc: acceptance matrix from brief Phase A ticked with evidence (run ids, row counts), plus the budget-abort test name.

---

## Self-Review

- **Spec coverage:** All Phase A build items are present — 9 models (brief's 8 + `AgentFleetState` which the brief references but never defines — D7), contracts + tests, charter-registry, observation-builder, agent-executor, orchestrator, fleet-graph, budget-guard, tracing, routes. `GraphEdge` correctly excluded (Phase H). Acceptance criteria map: selftest e2e (Task 10), budget abort mid-run in a test (Task 5 Step 1), tsc/vitest/drift (Tasks 1, 10), zero behaviour change (dark defaults + no cron + read-only routes).
- **Deviations from the brief, all argued above:** D1 (shared layout), D2 (Zod 4), D4 (route prefix), D5 (reuse `agentKey`), D6 (no embedding column), D12 (`AgentStep` over `AgentRun.steps`). None weaken an invariant; L1–L10 hold — notably L2/L3 are trivially satisfied because Phase A has no write path and no agent-spawning surface at all.
- **Placeholder scan:** the only intentionally-empty surface is `GET /agent/fleet/plans` (real query, empty table until Phase C) — honest, not a stub. `toolNames`/`maxToolCallsPerRun` are carried but unused until a later phase adds tool use; the budget guard still enforces the cap so the field is live, not dead.
- **Type consistency:** `AutonomyLevel` imported from `ads-autonomy.js` everywhere (never redeclared); `OutputSchemaKey` narrows `outputSchemaKey` at compile time; Prisma `Decimal` coerced via `Number(...)` at the service boundary (tool-policy idiom); all shared imports via `@nexus/shared/agent-fleet` (no `.js` on package specifiers, `.js` on all relative ones).
- **Risk:** (1) `apps/api` non-strict tsc — mitigated by tests on every null-bearing path and hand-read migration SQL. (2) Concurrent sessions on main — migration folder letter picked at implementation; commits use `--only`; pre-push builds the working tree, so batch-push happens on a coordinated tree. (3) Anthropic `jsonMode` is a prompt hint — executor strips fences and retries once with the Zod error; the twice-invalid path is a **failed run with zero blackboard writes**, which is the specified behaviour, and Phase B's "14 sweeps, zero validation failures" gate will measure how often it happens. (4) The 60s charter-policy cache means a halt-toggle takes effect immediately (fleet-state is read per-run, uncached) but an autonomy edit can lag ≤60s — same tradeoff tool-policy already accepted.

---

## Phase A verification — 2026-08-06 (local; live selftest pending push)

Implemented task-by-task with per-task local commits (`5492a220a` schema → `947fcd8d1` contracts → `7f74b9b76` registry → `54b6c6bb5` observations → `7255f2276` budget guard → `d70c6e195` state+tracing → `f8c17b0bc` executor → `0e002898b` graph+orchestrator → `2986b749c` routes+features). NOT pushed — batch push on operator command (Q4).

| Acceptance item (brief Phase A) | Status | Evidence |
|---|---|---|
| `tsc --noEmit` clean | ✅ | apps/api and packages/shared both clean; pre-push `tsc` build also green |
| vitest green | ✅ | 58 fleet tests (8 files) + 20 contract tests, all passing |
| `check:drift` clean | ✅ | table + column drift: 384 models, 0 drift |
| Budget abort fires mid-run in a test | ✅ | `budget-guard.vitest.test.ts` › "ACCEPTANCE: aborts mid-run when cumulative tokens cross the cap" (aborts at step 3 of 10) |
| Zero behaviour change; `enabled=false` everywhere | ✅ | no cron registered; charters seed dark; routes read-only + halt/seed/run-now; only existing files touched: `schema.prisma` (append), `index.ts` (2 lines), `ai-features.ts` (5 keys appended), shared package wiring |
| RBAC coverage | ✅ | 2,307 routes · 0 unmapped — fleet routes covered by the existing `/api/agent/` mapping (D4) |
| `.githooks/pre-push` | ✅ | full run green: drift ×2, i18n (5,594 refs), links, token guard, DS ratchet, apps/web build, apps/api build, RBAC, 82 security tests |
| `fleet-selftest` end-to-end from a real observation | ⏳ | **pending deploy** — on push, migration applies via `migrate-direct.mjs`; then `POST /api/agent/fleet/charters/seed` + `POST /api/agent/fleet/run/fleet-selftest` on prod Railway (Q2), acceptance matrix updated with run ids |

**Found during gates, NOT a NAF failure:** `npm run tokens:check` is RED on main and has been since 2026-06-29 — commit `99746dbe8` (rail P1) hand-added 28 `--h10-rail-*` variables directly into the generated `tokens.css` without porting them to `tokens/css-vars.ts`; regenerating would DELETE the live rail palette. `.githooks/pre-push` does not run tokens:check, which is why every push since has been green. Fix belongs to the design-system workstream: port the rail vars into `css-vars.ts`, then regen. Phase A makes no web changes.

**Implementation deviations, all recorded in code comments:** `ObservationResult` gained `id` (findings must cite real `AgentObservation` row ids — the plan's interface omitted the one field `evidenceRefs` needs); `fleet-selftest.maxToolCallsPerRun = 2` (>0 so the generic used≥cap continue-check doesn't trip a tool-less charter); fleet unions use optional-`undefined` members instead of discriminant narrowing (strict:false disables the narrow in source files, and vitest files are tsc-excluded — the plan's risk (1) made concrete); evidence-integrity (refs ⊆ shown observation ids) enforced as part of validation, so a hallucinated evidence id is a retried-then-failed run, not a stored finding.

## Obligations recorded for later phases (operator, 2026-08-06)

- **Phase C prerequisite — `apps/api` strict mode:** `strict:false` disables discriminated-union narrowing in source files (bitten in Phase A — `BudgetVerdict` needed optional-`undefined` members). The Critic's check union (`CriticOutput.checks[].result` driving block/revise flow) needs real narrowing. **Add "flip apps/api to strict (or at minimum strictNullChecks)" to the Phase C plan's open-questions list.**
- **Phase D obligation (existing, restated):** fleet lever registration in `getEngineLevers()` with `haltBehaviour: 'honours'` (D11), and the run timeline must read BOTH step shapes — `AgentStep` rows for fleet runs, `AgentRun.steps` Json for ACP copilot runs (D12).
- **Design-system workstream (not NAF):** TECH_DEBT #62 — port the 28 `--h10-rail-*` vars into `css-vars.ts` and add `tokens:check` to `.githooks/pre-push` **in the same commit**.

# NAF.B — Three Analysts in OBSERVE — Implementation Plan

> **STATUS: APPROVED 2026-08-06 with defaults (Q1 two-step enablement, Q2 defects stay reported, Q3 digest waits for Phase D) — implementation in progress, Phase B only.**
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
> **Spec:** `docs/AGENT_FLEET.md` Parts 0–3 (invariants) + Part 6 roster (first three Tier-1 analysts) + Part 12 § PHASE B.
> **Predecessors:** `docs/2026-08-06-naf-a-foundation.md` (Phase A closed on both provider paths) and `docs/2026-08-06-naf-a2-local-provider.md` (A2 — its two findings BIND this phase: the dedupeKey grammar gate and "schema validity ≠ recall").
> **Verified this session:** every engine surface below was read from the working tree by two exploration passes; file:line citations throughout. The delivery-model memory was re-read before planning the cron (analysts touch no write path).

**Goal:** The first three Amazon-ads analysts — `amazon-negative-miner`, `amazon-keyword-harvester`, `amazon-bid-tuner` — running nightly in OBSERVE over the Phase A substrate. Each reads TTL-cached deterministic evidence (wrapping `previewHarvest`, `analyzeNgrams`, `previewBidOptimization` + `ads-target-acos`), emits schema-validated findings with a **pinned dedupeKey grammar**, and is shadow-graded against the deterministic engine's own proposals from day one. Findings only: no plan, no approval, no write. Acceptance: 14 consecutive clean sweeps, ≤ €0.50/sweep, every finding evidenced and vintage-bounded, and a written agent-vs-engine comparison.

**Architecture:** Additive on Phase A. Three new charter files + three observation builders + one nightly cron (`fleet-sweep`, double-dark: env flag AND charters born OFF) + one small additive model (`AgentShadowGrade`) + one Control-Room lever row. The executor gains two OPTIONAL charter-enforced checks (dedupeKey pattern, evidence staleness) — `fleet-selftest` is untouched per operator ruling. No changes to `ads-write-gate.ts`, `approval-gate.service.ts`, or any engine service: the analysts consume the engines' existing pure-read entry points.

**Tech Stack:** unchanged from Phase A — TypeScript ESM (`.js` relative imports), Prisma (hand-authored migration), Zod 4 contracts already shipped, Vitest `*.vitest.test.ts`, `node-cron` via the house three-function idiom.

---

## Verified state (read this session — do not re-derive)

| # | Fact | Consequence |
|---|---|---|
| V1 | `analyzeNgrams` (`ads-ngram.service.ts:19`) is pure-read over `AmazonAdsSearchTerm.groupBy(['query'])`, account-global (**no marketplace param**), top-50 winning/wasteful buckets, min cost €3, default 60d window. Whole-query metrics are attributed to every gram — grams overlap by construction. | Wrappable as-is. Evidence must state the overlap caveat so the analyst doesn't sum gram spend. |
| V2 | `analyzeNgrams` has **zero callers**: the legacy web page fetches `GET /api/advertising/ngrams`, which does not exist. | Dead code today — wrapping it creates the first consumer; no regression surface. (Defect noted for the operator; not fixed here.) |
| V3 | `previewHarvest` (`ads-harvest.service.ts:39`) is pure-read over the same model, grouped by (query, campaignId, adGroupId) with **Amazon external ids**; negatives = 0 orders & spend ≥ €15, graduations = orders ≥ 2; ASIN-shaped queries split into product buckets; lists uncapped; scoping only via `adGroupExternalIds`. | The single evidence seam for BOTH negative-miner and harvester. Builders must cap + count what they trim (no-silent-caps). |
| V4 | `runAutoHarvestOnce` in SUGGEST mode leaves **no durable record** — a notification with counts only; in AUTO it applies directly (dropping product buckets). `AdsRuleSuggestion` is written by exactly one path (rules engine, `ads-suggestions.service.ts:74`), truncates harvest lists to 5, uses context-derived entityType (never SEARCH_TERM for scheduled harvest), and its upsert **destroys history**. | **Shadow-grading cannot lean on `AdsRuleSuggestion`.** The deterministic baseline must be snapshotted by us at sweep time (D3). |
| V5 | `previewBidOptimization` (`ads-bid-optimizer.service.ts:69`) is pure-read (`AmazonAdsDailyPerformance.groupBy` + `adTarget.findMany`, take 2000), returns `BidProposal[]` `{targetId, expression, matchType, currentBidCents, proposedBidCents, deltaCents, acos, spendCents, salesCents, clicks, reason, targetAcosUsed, targetBasis}`. **Default metric source `legacy` yields ZERO proposals on prod** — `NEXUS_BID_OPTIMIZER_SOURCE=daily` or explicit `source:'daily'` is required. Correctly filters `isNegative:false`. | The bid-tuner builder passes `{profitMode:true, bayesian:true, source:'daily'}` explicitly — never trusts the env default. |
| V6 | `ads-target-acos.service.ts`: `computeFleetTargetAcos`/`computeAdGroupTargetAcos` are read-only; `basis` is `'profit-data' \| 'estimated-cost' \| 'fallback'` and only `profit-data` is real — the other two return the 0.3 default. COGS is still unloaded on prod (ACR 0.5), so basis will be estimated/fallback almost everywhere. | Evidence carries `basis` verbatim; the charter prompt forbids treating fallback targets as profit truth. |
| V7 | Negative-mining as a service **does not exist**; candidates come from `previewHarvest().negatives`. Existing negatives must be read via the `isNegative` boolean — `ads-coverage.service.ts:290-301` is the canonical correct pattern; 1,068 negatives are stored with `expressionType='EXACT'`. | The negative-miner builder queries existing negatives with `isNegative:true` only. |
| V8 | **Pre-existing defect (confirmed, not ours):** `createNegative`'s idempotency probe (`ads-negative-kw.service.ts:93-117`) and `createNegativeKeywordCampaignLocal`'s dedupe (`ads-create.service.ts:1068-1071`) filter on the `NEGATIVE_*` spelling — the wrong side of the trap — so they miss synced negatives and can re-POST to Amazon. | Reported to operator (below). NOT fixed in NAF.B (write path, L2). |
| V9 | **Pre-existing defect (confirmed, not ours):** `applyBidOptimization` (`ads-bid-optimizer.service.ts:235`) passes `{changes:…}` into `bulkUpdateAdTargetBids` whose real signature takes `{entries:…}`, suppressed by an `as never` cast — latent crash on first non-empty apply; masked today because the `legacy` source yields zero proposals. | Reported to operator (below). NOT fixed in NAF.B (write path, L2). |
| V10 | Cron idiom: register the `*Once` fn in `CRON_REGISTRY` (`cron-registry.ts:134`) — registering the `*Cron` wrapper double-writes `CronRun` (documented at `:234-245`). Scheduling = three-function idiom; the self-gated variant (`ad-rank-defend.job.ts:721-732`: env flag early-return + schedule override + module-level overlap guard) fits a job that must not depend on `NEXUS_ENABLE_AMAZON_ADS_CRON`. Manual trigger comes free via `POST /sync-logs/cron/:jobName/trigger` once the registry key exists. | `fleet-sweep` follows the rank-defend shape with its own flag. |
| V11 | `getEngineLevers()` (`ads-control-room.service.ts:174`): new engines add a name to the `CRONS` array (`:175-180`) AND a `mk(...)` entry in the levers array (`:261-331`); `haltBehaviour:'exempt'` with a read-only explanation is the precedent (`structural-reconcile`, `:325-330`). The engine→cron map defect (ACR: "the row exists but its detail does not") is avoided by the detail service resolving from `getEngineLevers()` itself. | The sweep registers a lever row IN THIS PHASE — revisiting Phase A's D11 deferral, because Phase B is scheduled and ads-domain (D6). |
| V12 | A2-V7/V10 carry over: the executor emits one `model` + one `validation` step per attempt (retry rate computable from `AgentStep` alone), and `AgentFinding`'s unique holds **iff the model emits a stable dedupeKey** — measured failure: 4 key families for one entity across runs; reconfirmed on Haiku (a 5th family). | D1 makes the grammar a validated contract, not a prompt hope. |
| V13 | Phase A executor validates `evidenceRefs ⊆ shown observation ids` and retries once with the error appended; `charter-registry` matches DB rows by exact `(key, version)`; observation cache updates in place so the row id is stable across recomputes. | New charters are version 1 rows; findings cite stable observation ids; the staleness check (D2) composes with the existing validation stage. |
| V14 | Analyst model routing: `agent-fleet-analyst` is pinned to `anthropic/claude-haiku-4-5` ($1/$5 per MTok) by per-feature `AiFeatureModelPref`; the hosted selftest measured 4,377 in + 1,930 out = **$0.014** for one analyst run. The local provider exists behind `NEXUS_LOCAL_AI_FEATURES` (A2), ~50× slower, $0. | Cost projection: 3 analysts/night ≈ $0.05–0.09 ≪ €0.50 acceptance bound (D7). |

---

## Decisions (call out if you disagree)

| # | Decision | Rationale |
|---|---|---|
| D1 | **dedupeKey grammar becomes a charter contract.** `CharterDefinition` gains OPTIONAL `dedupeKeyPattern?: string` (a regex source). When present, the executor's validation stage rejects any finding whose `dedupeKey` fails the regex — same retry-once-then-fail path as schema errors, so a sloppy key is a failed run, never a blackboard write. All three new charters pin `^[a-z_]+:[^:\s]+$` with the prompt instructing exactly `<kind>:<entityId>`. `fleet-selftest` stays pattern-free (operator ruling: no retrofit). A key-stability metric (distinct keys per entity, target = 1) lands in the sweep report. | A2 measured 4 key families from one model and the hosted run added a 5th; the unique index held but semantic dedupe failed 13/16 entities. Prompt guidance alone is hope; a validated contract is enforcement. Optional field ⇒ zero behaviour change for Phase A charters. |
| D2 | **Evidence staleness becomes a charter contract.** `CharterDefinition` gains OPTIONAL `maxEvidenceAgeHours?: number`; the executor rejects a run (before the model call — a `gate` step, no spend) when any gathered observation's `dataVintage` is older. New charters set 26h (nightly cadence + report-ingest slack). | Acceptance requires "dataVintage within its charter's staleness tolerance" — Phase A had no tolerance anywhere. Checking BEFORE generation means stale evidence costs $0. |
| D3 | **Shadow-grading = deterministic snapshot at sweep time, stored per finding in a new `AgentShadowGrade` table** (`findingId` unique, `engineKey`, `engineProposal Json` — the matching engine rows only, `agrees Boolean`, `disagreementReason String?`, `gradedAt`). A pure-code grading pass runs inside the sweep after each analyst: for each new/refreshed finding, it matches the entity against the engine output **already in the cited observation payload** and records agreement. No LLM involved. | V4 killed the `AdsRuleSuggestion` route (5-item truncation, no history, wrong entity keys, SUGGEST evaporates). The observation the analyst read IS the engine's proposal set — snapshotting the match at grade time gives day-one agreement measurement with zero extra engine calls, and survives observation TTL expiry. |
| D4 | **Evidence trimming: every builder caps lists and counts what it trims** (the cron-health idiom). negative-candidates: top 25 by cost + existing-negative check (`isNegative` only, V7) + ngram wasteful top 15 with the overlap caveat stated in the payload. harvest-candidates: top 25 graduations + top 10 product-graduations. bid-proposals: top 25 by |delta| + fleet target-ACOS summary with `basis` verbatim (V6). | L1 (pass conclusions), token budgets (~4-7k in/run on Haiku), and no-silent-caps. Thresholds are builder constants, surfaced in the payload so the analyst knows the screen. |
| D5 | **Marketplace scope is stated, not faked.** `previewHarvest`/`analyzeNgrams` are account-global (V1/V3); the account is IT-primary. Builders run unscoped, payloads carry `scope:'account'`, charters' `scopeMarketplaces` stays `[]`, and prompts say the evidence is account-level. Per-marketplace evidence is deferred until an engine grows a marketplace param. | Scoping the charter while the evidence can't be scoped would be a lie in the data. Honest labelling beats fake precision. |
| D6 | **The fleet sweep registers in `getEngineLevers()` NOW** — one `mk('fleet-analysts', …, 'fleet-sweep', 'nightly', mode-from-charters, …, 'exempt')` row + `'fleet-sweep'` in the `CRONS` array. `haltBehaviour:'exempt'` with the `what` text stating it is read-only and honours its OWN halt (`AgentFleetState` + `NEXUS_AI_KILL_SWITCH`), not the ads write halt. Phase A's D11 deferral is superseded: that rationale ("dark and unscheduled") no longer holds for a scheduled ads-domain engine, and ACR's row-exists rule applies. | The Levers board is the operator's inventory of scheduled machines; an unlisted nightly cron is exactly the "engine invisible to the control surface" defect ACR spent a week killing. `exempt` follows the structural-reconcile precedent for read-only engines (V11). |
| D7 | **The sweep runs hosted (Haiku 4.5) for the 14-sweep acceptance window.** Projected ~$0.06/sweep (V14), bound checked per sweep in the report. The local provider stays a Phase J lever the operator can flip via `NEXUS_LOCAL_AI_FEATURES` at any time — but the acceptance gate measures the fleet as it will actually run, and A2 showed local latency (~57s/run) is fine for a nightly sweep yet its $0 cost makes the money-based day budgets inert (A2-V14), which would un-test the budget path. | Comparability with the Phase A hosted baseline, live budget enforcement, and a real cost number for the acceptance bound. |
| D8 | **Sweep schedule: `NEXUS_FLEET_SWEEP_SCHEDULE ?? '45 4 * * *'` (04:45 UTC), self-gated by `NEXUS_ENABLE_FLEET_SWEEP_CRON !== '1'` early-return** (rank-defend shape, V10), overlap-guarded, registered as `fleet-sweep` → `runFleetSweepOnce` in `CRON_REGISTRY`. Double-dark on deploy: flag unset AND charters OFF. The 14-sweep clock starts when the operator sets the flag + enables the charters to OBSERVE. | 04:45 sits after the nightly ads report ingest cycle (search-term data landed) and before auto-harvest's 06:30, so the analysts read the same morning data the deterministic cron will act on — which is what shadow-grading wants to compare. Own flag (not `NEXUS_ENABLE_AMAZON_ADS_CRON`) because the fleet is not an ads write engine and must be startable/stoppable independently. |
| D9 | **Charter budgets:** each analyst `maxTokensPerRun 20_000`, `dailyBudgetUSD 0.10`, `maxFindingsPerRun 20`, `autonomyCap 'OBSERVE'`, `modelFeature 'agent-fleet-analyst'`, `cadence: undefined` (orchestrated only — the sweep is the scheduler). `FLEET_GRAPH` gains three analyst nodes, no edges (directors are Phase C). | 3 × $0.10 day-caps bound a runaway retry storm at ~7× the expected sweep cost while staying far under the $2 fleet ceiling. OBSERVE cap per L5 — Phase B findings may carry `proposedTool` data but nothing consumes it. |
| D10 | **Migration `20260806<letter>_nafb_shadow_grade`** creates only `AgentShadowGrade` (committed with schema.prisma; letter picked at implementation — concurrent sessions mint same-day folders). | One small table; everything else in Phase B is code. Additive migrations are pre-approved by standing rule; this is not destructive. |
| D11 | **Two pre-existing write-path defects found by this planning pass are REPORTED, not fixed** (V8 negative-dedupe on the wrong side of the isNegative trap → duplicate POSTs to Amazon; V9 `applyBidOptimization` `{changes}`-vs-`{entries}` latent crash under an `as never` cast). Both live in the write path Phase B must not touch (L2, and the brief's "do not touch existing signatures"). | Fixing them inside an analysts phase would smuggle write-path changes past the phase gate. They deserve their own gated fix with tests — flagged in this plan and in the final report so they don't vanish. |

## Open questions for the operator (defaults stated; none block plan approval)

1. **Sweep enablement sequencing** — deploy dark, then enable in two steps (flag first to watch no-op runs, then charters to OBSERVE)? Default: yes, flag first for 1–2 nights of `skipped=disabled` CronRun evidence, then enable all three charters at once; the 14-sweep clock starts at charter enablement.
2. **The two reported defects (V8/V9)** — want a separate fix plan queued after Phase B approval, or leave them on the books? Default: leave reported; V8 has real duplicate-POST cost but is bounded by Amazon-side idempotency of duplicate negatives; V9 is unreachable while `legacy` remains the default source.
3. **Weekly digest hook** — the existing ads weekly digest could carry a one-line fleet section (findings/agreement counts) in Phase B, or wait for the Phase D Control Room. Default: wait (no web/email surface changes in this phase).
4. **Phase C prerequisite reminder (not a Phase B question):** flip `apps/api` toward `strict` (or `strictNullChecks`) before the Critic lands — carried on the books from the Phase A closure.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/database/prisma/schema.prisma` (modify — append) | `AgentShadowGrade` model. |
| `packages/database/prisma/migrations/20260806<letter>_nafb_shadow_grade/migration.sql` (create) | Hand-authored DDL for it. |
| `apps/api/src/services/agent-fleet/charter-types.ts` (modify) | Optional `dedupeKeyPattern?: string`, `maxEvidenceAgeHours?: number` on `CharterDefinition`. |
| `apps/api/src/services/agent-fleet/agent-executor.ts` (modify) | Enforce both when present: staleness as a pre-model `gate` step (deny = $0), pattern as part of the validation stage (retry-once path). |
| `apps/api/src/services/agent-fleet/observations/negative-candidates.observation.ts` (create) | `previewHarvest().negatives/productNegatives` (trimmed) + existing negatives via `isNegative` + `analyzeNgrams().wasteful` (trimmed, overlap caveat). TTL 6h. |
| `apps/api/src/services/agent-fleet/observations/harvest-candidates.observation.ts` (create) | `previewHarvest().graduations/productGraduations` (trimmed). TTL 6h. |
| `apps/api/src/services/agent-fleet/observations/bid-proposals.observation.ts` (create) | `previewBidOptimization({profitMode:true,bayesian:true,source:'daily'})` (trimmed by \|delta\|) + `computeFleetTargetAcos` summary with `basis`. TTL 6h. |
| `apps/api/src/services/agent-fleet/charters/amazon-negative-miner.charter.ts` (create) | v1, ops→amazon-ads domain, OBSERVE cap, pinned grammar, staleness 26h. |
| `apps/api/src/services/agent-fleet/charters/amazon-keyword-harvester.charter.ts` (create) | v1, same contracts. |
| `apps/api/src/services/agent-fleet/charters/amazon-bid-tuner.charter.ts` (create) | v1, same contracts. |
| `apps/api/src/services/agent-fleet/charter-registry.ts` (modify) | Register the three charters. |
| `apps/api/src/services/agent-fleet/fleet-graph.ts` (modify) | Three analyst nodes. |
| `apps/api/src/services/agent-fleet/shadow-grade.service.ts` (create) | Pure matching (per engine key) + `gradeFindings(runIds)` persisting `AgentShadowGrade`. |
| `apps/api/src/services/agent-fleet/sweep-report.service.ts` (create) | Per-sweep stats: runs, validation failures, retry rate, cost, key-stability (distinct keys/entity), agreement rate — the data feeding the acceptance write-up. |
| `apps/api/src/jobs/fleet-sweep.job.ts` (create) | `runFleetSweepOnce` (runFleet('sweep') → gradeFindings → summary string), `runFleetSweepCron`, `startFleetSweepCron` (self-gated, overlap-guarded). |
| `apps/api/src/jobs/cron-registry.ts` (modify) | `'fleet-sweep': () => runFleetSweepOnce()…` (the `*Once`, never the wrapper). |
| `apps/api/src/index.ts` (modify) | `startFleetSweepCron()` call. |
| `apps/api/src/services/advertising/ads-control-room.service.ts` (modify) | `'fleet-sweep'` in `CRONS` + one `mk('fleet-analysts', …, 'exempt')` lever row. |
| co-located `*.vitest.test.ts` (create) | TDD per module; Prisma + engine services mocked at module boundaries. |

---

### Task 1: charter contracts — dedupeKey pattern + staleness (executor)

- [ ] **Step 1: failing tests** (`agent-executor.vitest.test.ts` additions + `charter-registry` untouched): pattern present + bad key → validation failure → retry with the pattern named in the correction prompt → good key succeeds; twice-bad → failed run, zero findings; pattern absent (fleet-selftest) → behaviour identical to today; stale observation vs `maxEvidenceAgeHours` → run denied BEFORE the provider is called (gate step, provider mock never invoked, run row carries `haltedReason:'stale_evidence…'`); fresh → proceeds.
- [ ] **Step 2: red → implement → green** — `charter-types.ts` optional fields; executor: staleness check after observation gathering (pre-model), pattern check inside `validateReply`.
- [ ] **Step 3: tsc + commit** — `feat(naf): NAF.B charter contracts — pinned dedupeKey grammar + evidence staleness, both charter-opt-in`.

### Task 2: the three observation builders

- [ ] **Step 1: failing tests** per builder (engine fns mocked): trimming caps applied AND trimmed counts reported; negative-candidates queries existing negatives with `isNegative:true` and NEVER an `expressionType` filter (assert on the mock's `where`); bid-proposals passes `source:'daily'` explicitly (assert on the mock call); ngram payload carries the overlap caveat string; all payloads carry `scope:'account'` + threshold constants.
- [ ] **Step 2: red → implement → green** — three builders + registry entries in `observation-builder.ts` (BUILDERS map). TTL 6h each.
- [ ] **Step 3: tsc + commit** — `feat(naf): NAF.B observation builders — harvest/negative/bid evidence, trimmed and honest`.

### Task 3: the three charters + graph

- [ ] **Step 1: failing tests** — registry resolves all three at v1 with OFF/disabled floor; `dedupeKeyPattern` and `maxEvidenceAgeHours` present on all three; `FLEET_GRAPH` topo = one level of four analyst nodes.
- [ ] **Step 2: red → implement → green** — charters (prompts: role, evidence description incl. caps/caveats, `<kind>:<entityId>` grammar with examples, kinds enumerated per charter — negative-miner: `waste_term`, `negative_exists_gap`; harvester: `harvest_candidate`; bid-tuner: `bid_above_target`, `bid_below_target`; empty-findings-valid clause), registry, graph.
- [ ] **Step 3: tsc + commit** — `feat(naf): NAF.B charters — negative-miner, keyword-harvester, bid-tuner, born OFF`.

### Task 4: AgentShadowGrade — schema + grading service

- [ ] **Step 1: schema + migration** — model (`findingId @unique`, `engineKey`, `engineProposal Json`, `agrees Boolean`, `disagreementReason String?`, `gradedAt`), hand-authored SQL, `check:drift` + `check:column-drift` green, `prisma generate`, tsc.
- [ ] **Step 2: failing tests** — pure matchers per engine (finding entity ↔ harvest candidate / bid proposal / negative candidate; agree/disagree/absent cases); `gradeFindings` persists one row per finding, idempotent re-grade updates in place.
- [ ] **Step 3: red → implement → green.**
- [ ] **Step 4: commit** — schema+migration first (`--only`), then service+tests.

### Task 5: fleet-sweep job + registry + lever row

- [ ] **Step 1: failing tests** — `runFleetSweepOnce` (orchestrator + grader mocked): calls `runFleet('sweep')`, grades the sweep's runs, returns a summary string with started/succeeded/failed/skipped/graded/cost; overlap guard skips a second concurrent invocation.
- [ ] **Step 2: red → implement → green** — job file (three-function idiom, self-gated on `NEXUS_ENABLE_FLEET_SWEEP_CRON`, schedule `NEXUS_FLEET_SWEEP_SCHEDULE ?? '45 4 * * *'`), `CRON_REGISTRY['fleet-sweep']` → the `*Once`, `index.ts` start call, `CRONS` + `mk('fleet-analysts', …)` lever row (`exempt`, read-only wording).
- [ ] **Step 3: RBAC + tsc + commit** — `feat(naf): NAF.B nightly sweep — double-dark cron + Control Room lever`.

### Task 6: sweep report service

- [ ] **Step 1: failing tests** — given seeded runs/steps/grades fixtures: per-sweep stats (runs by status, validation-failure and retry counts from `AgentStep`, cost sum, key-stability = max distinct dedupeKeys per (charter, entity) — target 1, agreement rate per charter), 14-sweep rollup shape.
- [ ] **Step 2: red → implement → green** — service + a read-only route `GET /agent/fleet/sweeps` (mounted under the existing `/api/agent/` RBAC prefix).
- [ ] **Step 3: tsc + commit** — `feat(naf): NAF.B sweep report — the acceptance evidence, queryable`.

### Task 7: phase gates + deploy + supervised first sweep

- [ ] **Step 1: full suite** — `vitest run src/services/agent-fleet src/jobs/fleet-sweep*` + shared tests green; tsc clean both packages; `check:drift`; `.githooks/pre-push`.
- [ ] **Step 2: deploy** — push on operator command; migration applies on boot; verify boot log.
- [ ] **Step 3: seed + supervised run** — `POST /api/agent/fleet/charters/seed` (adds the three, dark); one manual `POST /api/agent/fleet/run/<key>` per charter with charters still OFF (`ignoreEnabled`), verifying: findings with grammar-conformant keys, shadow grades written, cost per run, staleness gate live. Fill this plan's acceptance table.
- [ ] **Step 4: enablement handoff** — per Q1 default: operator sets `NEXUS_ENABLE_FLEET_SWEEP_CRON=1`, watches 1–2 dark sweeps, then flips the three charters to OBSERVE via the charter policy; the 14-sweep clock starts. The written comparison doc is produced at the gate from `GET /agent/fleet/sweeps` + `AgentShadowGrade`.

---

## Acceptance mapping (brief Phase B → this plan)

| Brief acceptance | Where it lands |
|---|---|
| 14 consecutive sweeps, zero schema-validation failures | Sweep report counts validation failures from `AgentStep`; D1's grammar gate rides the same counter. |
| Every finding ≥1 evidenceRef + vintage within tolerance | Phase A already enforces refs ⊆ shown ids; D2 enforces vintage per charter — both are run-failing checks, so a violation cannot reach the blackboard. |
| Cost per sweep ≤ €0.50 | Per-sweep cost sum in the report; projection $0.05–0.09 (V14, D7). |
| Written agent-vs-engine comparison | `AgentShadowGrade` (D3) + sweep report → gate document, disagreements enumerated with `disagreementReason`. |
| Gate: operator reads 50 findings | `GET /api/agent/fleet/findings?charterKey=…` already exists; the gate doc links the 50 most recent. |

## Self-Review

- **Spec coverage:** three charters ✓, observation builders wrapping the named engines ✓ (funnel/graduation-readiness/sqp/keyword-conflicts from the roster's wider source lists deferred — the brief's Phase B section names ngram/harvest/bid-optimizer/bayesian/target-acos, all covered), nightly sweep via cron-registry ✓, shadow-grading from day one ✓, findings-only ✓ (no plan/approval/write; OBSERVE caps).
- **A2 bindings honoured:** dedupeKey grammar is enforced (D1) not hoped; recall is measured against the engine (D3) not assumed from schema validity.
- **Invariants:** L1 (engines compute, analysts judge — builders pass conclusions), L2/L3 (no write path, no spawning — the sweep is the only starter), L4 (validation extended, never weakened), L5 (born OFF, OBSERVE by operator act), L6 (steps/cost per run unchanged), L8 (shadow-grading is deterministic code), L9 (routing through model-resolver; local stays a flip).
- **Honesty items:** account-global evidence labelled as such (D5); trimmed lists counted (D4); `basis` carried verbatim (V6); two found defects reported not buried (D11).
- **Risk:** (1) `previewHarvest` uncapped lists on a big search-term table — builders trim immediately after the call; if the groupBy itself becomes heavy, the observation TTL (6h) bounds frequency. (2) Prompt-size drift as candidate lists grow — caps are constants with the counts in the payload, and `maxTokensPerRun` still hard-bounds. (3) Concurrent sessions — migration letter picked at implementation; commits `--only`. (4) The 26h staleness window assumes the report ingest keeps landing nightly; a broken ingest fails the sweep loudly (gate step) rather than analysing stale data — which is the correct failure.

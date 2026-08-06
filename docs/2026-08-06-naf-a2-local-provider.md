# NAF.A2 — Local OpenAI-compatible provider + Phase A acceptance closure — Implementation Plan

> **STATUS: APPROVED 2026-08-06 — all six open questions resolved by the operator (see below); implementation proceeding task-by-task, A2 only.**
> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.
> **Spec:** `docs/AGENT_FLEET.md` Parts 0–3 (invariants; **L9** is the governing law here) + Part 9.1 (local-vs-cloud by tier) + Part 12 § PHASE J (the local provider is a Phase J deliverable, pulled forward for a Phase A acceptance purpose — see D0).
> **Predecessor:** `docs/2026-08-06-naf-a-foundation.md`. Phase A is built, committed and deployed; its acceptance matrix has exactly one unmet row — *"`fleet-selftest` end-to-end from a real observation"* — blocked at the provider call by an unfunded Anthropic account (run `cmsh1ewlm000vmv01zanpxgbq`, status `failed`, zero `AgentFinding` rows).
> **Verified this session:** every repo claim in "Verified state" below was re-read from the working tree (provider contract, `ProviderName` blast radius, registry iteration order, executor step emission, observation TTL/cache semantics, charter version matching, `npm run dev` cron behaviour).

**Goal:** Close the last Phase A acceptance item without spending a cent at a vendor, by adding a local OpenAI-compatible provider (LM Studio / Ollama shape) behind the existing `LLMProvider` contract and routing the `agent-fleet-analyst` feature key to it. Then run `fleet-selftest` against a local model enough times to fill the acceptance matrix **and** produce the first schema-validation retry-rate datapoint for the Phase J bake-off.

**Architecture:** Additive only, and deliberately *small*. One new file implements `LLMProvider` over `POST {base}/chat/completions`. The `ProviderName` union widens by one member; the three rate-card functions widen with it and price `local` at exactly zero. `getProviderForFeature` gains one env-gated branch so named feature keys route to the local provider — a branch that is provably dead when `NEXUS_LOCAL_AI_BASE_URL` is unset, which is the state of production. No agent-fleet file changes. No schema change. No migration. No cron. No web change.

**Tech Stack:** TypeScript ESM (`.js` relative imports — load-bearing at runtime), `fetch` (no new dependency; the Anthropic provider already sets this precedent), Vitest (`*.vitest.test.ts` — plain `*.test.ts` is excluded by `apps/api/vitest.config.ts`), `AbortSignal.timeout` for the local-generation timeout.

---

## Verified state (re-read this session — do not re-derive)

| # | Fact | Consequence for this plan |
|---|---|---|
| V1 | `providers/types.ts` defines the whole contract: `LLMProvider { name, defaultModel, isConfigured(), generate() }`, `GenerateOptions { prompt, temperature?, maxOutputTokens?, jsonMode?, model?, feature?, entityType?, entityId? }`, `GenerateResult { text, usage }`, `ProviderUsage { inputTokens, outputTokens, costUSD, model, provider }`. | The local provider implements exactly this. Nothing else changes shape. |
| V2 | `ProviderName = 'gemini' \| 'anthropic'` is a **closed union** referenced by 15 source files. | Widening it is the one structurally invasive act in this plan. |
| V3 | Two call sites pass a `ProviderName`-typed *variable* into `priceFor(provider: 'gemini' \| 'anthropic', …)`: `cost-preview.service.ts:139` and `budget.service.ts:135`. | Widening `ProviderName` without widening `rate-cards.ts` = 2 `tsc` errors. Both must land in one commit (D3). |
| V4 | `providers/index.ts` `getProvider()` step 3 is `for (const p of Object.values(REGISTRY)) if (p.isConfigured()) return p`. | **Registry insertion order is behaviour.** `local` must be appended LAST or a laptop with all three configured would silently reroute existing features. Regression-tested (Task 2). |
| V5 | `model-catalog.service.ts` carries its own `CatalogProvider = 'anthropic' \| 'gemini'` union and only discovers those two. | The local provider is invisible in Settings→Models unless catalog discovery is added. Deferred (D5) — no web change, no prod UI change. |
| V6 | `AiModelsClient.tsx` renders only providers matching `configured && models.length`. | Even if the catalog later grows a `local` entry, prod (env unset ⇒ `configured:false`) renders nothing new. |
| V7 | `agent-executor.ts` emits **one `AgentStep` of `type:'model'` and one of `type:'validation'` per attempt**, and retries at most once. | The retry rate is computable from `AgentStep` alone. **No new instrumentation is needed for acceptance (e).** |
| V8 | The executor writes the observation step output as `{ id, cached, dataVintage }`, and `observation-builder.getObservation()` returns the `AgentObservation` row id with `cached: true` on a TTL hit. | Acceptance (b) is verifiable **by id**, exactly as asked, with no code change. |
| V9 | `cron-health` builder TTL is 30 minutes; `dataVintage` is the computation time. | All runs inside one 30-minute window share one observation row. |
| V10 | `AgentFinding` unique is `(charterKey, entityType, entityId, dedupeKey)` and the executor `upsert`s on it. | Acceptance (c) holds **iff the model emits a stable `dedupeKey`**. The charter does not currently prescribe a format — see Q4. |
| V11 | `fleet-selftest` charter: `maxTokensPerRun 20_000`, `dailyBudgetUSD 0.25`, `maxFindingsPerRun 10`, `modelFeature 'agent-fleet-analyst'`, `autonomyCap 'OBSERVE'`, `enabled=false`. Executor derives `maxOutputTokens = min(8192, max(1024, 20000/4)) = 5000` and sends `temperature: 0.2`. | The local model needs ≥16k context to hold ~4k of prompt plus a 5k-token reply. |
| V12 | `charter-registry.loadDbPolicies()` matches DB rows by **exact `version`**. | Any charter edit implies a version bump + re-seed. Relevant only if Q4 is answered "bump now". |
| V13 | `cd apps/api && npm run dev` boots on **:8080** and starts **every** registered cron against **production Neon**; there is no `DISABLE_CRON` flag (memory: `reference_local_api_duplicates_prod_crons`). | A local API is a second cron runner competing with Railway — and it writes `CronRun` rows, i.e. it perturbs the very evidence `cron-health` reads. Drives D8. |
| V14 | Local inference costs $0.00, and `checkCharterDayBudget` / `checkFleetDayBudget` sum `AgentRun.costUSD`. | Both day budgets are **inert** on local runs. The only live ceiling is `maxTokensPerRun`. Honest finding; recorded for Phase J, not "fixed" here. |
| V15 | `apps/api/src/services/ai/` contains **no** vitest files today. | Every test file in this plan is a new file — purely additive. |

---

## Decisions (call out if you disagree)

| # | Decision | Rationale |
|---|---|---|
| **D0** | **This is Phase J work pulled forward, scoped to what Phase A acceptance needs.** It builds the provider and the routing; it does **not** build the Phase J eval harness, the frozen 200-situation eval set, or the scheduled bake-off report. | The brief puts the local provider in Phase J. Building it now is justified because Phase A cannot otherwise close. Building the *eval harness* now is not — it needs the Phase B corpus. The retry-rate number this session produces is recorded as **datapoint #1**, not as a bake-off. |
| **D1** | Provider name is **`local`**, appended **LAST** to `REGISTRY`. Not `lmstudio`/`ollama` — the wire format is the contract, not the vendor. | `local` matches the brief's own vocabulary (Part 9.1, Phase J). Last position preserves `getProvider()`'s "first configured" outcome bit-for-bit on a machine where Gemini/Anthropic keys are also present (V4). |
| **D2** | Config via env: `NEXUS_LOCAL_AI_BASE_URL` (the only thing `isConfigured()` reads), `NEXUS_LOCAL_AI_MODEL`, `NEXUS_LOCAL_AI_API_KEY` (optional), `NEXUS_LOCAL_AI_TIMEOUT_MS`, `NEXUS_LOCAL_AI_FEATURES`. | Matches the repo's split: vendor keys unprefixed (`GEMINI_API_KEY`), app config `NEXUS_`-prefixed (`NEXUS_ENABLE_*`, `NEXUS_AI_KILL_SWITCH`). Unset base URL ⇒ `isConfigured() === false` ⇒ the provider is unreachable by every resolution path. |
| **D3** | `rate-cards.ts` widens `rateInfoFor` / `rateCardFor` / `priceFor` from `'gemini' \| 'anthropic'` to `ProviderName`, with an early return for `local`: `{ inputPer1M: 0, outputPer1M: 0, known: true }`. | Forced by V3. `known: true` because zero is *exact*, not an estimate — a local run must not be flagged `costEstimated`. Existing inputs take an identical path; this is a parameter widening, not a behaviour change. |
| **D4** | **Feature routing by env allowlist.** `getProviderForFeature` gains one branch, consulted **only when the local provider `isConfigured()`**: if `NEXUS_LOCAL_AI_FEATURES` (comma list, or `*`) contains the feature key, return the local provider. Placed **after** the kill-switch, `lockedProvider`, and explicit per-call `requested` checks; **before** `AiFeatureModelPref`. Widening `isValidProviderName` *also* makes an `AiFeatureModelPref` row with `provider:'local'` legal — that capability exists but **is not used this session**. | The user asked for routing "through model-resolver", and this is the one file where that decision belongs. Env over DB pref because **the local API reads the production Neon database**: writing `AiFeatureModelPref{agent-fleet-analyst → local}` would pin *production's* analyst tier to a provider production cannot reach, and would survive the session if I forgot to delete it. An env var on one laptop cannot do that. On prod the variable is unset and the branch is unreachable. |
| **D5** | **`model-catalog.service.ts` is NOT extended**; the local provider does not appear in Settings→Models, and `apps/web` is untouched. | Keeps the diff to five files and zero web deploys. The operator gets the exact model id from `GET /v1/models` (one `curl`). Recorded as a Phase J follow-up. Reversible; see Q5 if you want it now. |
| **D6** | `jsonMode: true` maps to `response_format: { type: 'json_object' }` **only**. **No `json_schema` / GBNF-constrained decoding**, even though LM Studio supports it. | `json_object` is the exact fidelity Gemini already gets (`responseMimeType`), so the two are comparable. Schema-constrained decoding would drive the retry rate to ~0 by construction and **destroy the datapoint acceptance (e) exists to produce**. It is a legitimate Phase J lever — recorded there, not used here. This is also why the Zod schemas stay untouched: the retry rate *is* the finding. |
| **D7** | The local provider sets a request timeout (`AbortSignal.timeout`, default **300 000 ms**, override `NEXUS_LOCAL_AI_TIMEOUT_MS`). Gemini/Anthropic remain untimed. | Node's `fetch` has no default timeout. A 14B model asked for 5 000 output tokens can legitimately take minutes; a stalled load can hang forever and wedge the run with `status:'running'`. Local-only addition — existing providers' behaviour is not touched. |
| **D8** | **Verification runs through a `tsx` script harness that calls `executeCharter()` directly**, not `npm run dev`. ~~One optional HTTP confirmation…~~ **Operator ruling 2026-08-06: harness only; the HTTP confirmation (Task 6b) is deleted.** | V13: a local API starts every cron against prod Neon — a second cron runner competing with Railway, writing `CronRun` rows, i.e. *contaminating the observation under test*. The HTTP route is **already proven on prod** (2026-08-06 live verification reached the provider call through `POST /api/agent/fleet/run/fleet-selftest`); what is unproven is provider → validation → persistence, and the script exercises that path identically, in the same process, through the same executor. This is my recommendation and the reason I am not doing what you literally asked — Q2 is yours to overrule. |
| **D9** | Evidence rows land in **production Neon**, in the dark fleet tables (`AgentRun`, `AgentStep`, `AgentObservation`, `AgentFinding`) only. No `AiFeatureModelPref` row, no schema change, no cron, no charter row edit. `AiUsageLog` will gain rows with `provider:'local'`, `costUSD: 0`. | Continuity with the Phase A verification venue (Q2 of the predecessor plan: "prod Railway"), and `cron-health` needs real `CronRun` data to be a real observation. The tables are empty and unread by any live surface. See Q3 for the isolation alternatives. |

---

## Open questions — ALL RESOLVED by operator 2026-08-06

1. **Model** — **`qwen/qwen3-14b`, Q4_K_M / MLX-4bit, thinking mode OFF.** Plus an operator-added gate: **before the 10-run measurement, one `curl` must prove no reply contains `<think>`; if any does, stop and switch to Mistral Small 3.2 24B rather than measuring a formatting artefact as a reasoning failure.** The write-up must record which model and which thinking setting produced the numbers. → Task 6 Step 0.
2. **Venue** — **harness only.** Operator: *"your reasoning is correct and overrides my earlier instruction — `npm run dev` would boot a second cron runner against prod Neon and write the `CronRun` rows that `cron-health` reads."* **Task 6b is deleted, not deferred.**
3. **Evidence rows** — **production Neon, dark tables.** Continuity with Phase A; a local Postgres would leave the observation empty, which voids the test.
4. **`dedupeKey`** — **measure first**, and report *"dedupe constraint held"* and *"keys were stable"* as **two separate results**. **Do NOT bump the charter to v2**: operator ruling — *"changing what Phase A shipped in order to make Phase A's acceptance pass is backwards. If keys prove unstable, that is a finding about charter design and it belongs in the Phase B charter template, not in a retrofit."*
5. **Settings→Models** — **skip.** `apps/web` untouched. Revisit at Phase J.
6. **Bake-off harness** — **committed**, as a `apps/api/scripts/` artefact in the ACR style (`_`-prefixed, tracked — 944 such scripts are already in git). (e) must be repeatable; this is the seed of the Phase J bake-off harness.

**Endorsed as stated (operator):** `ProviderName` widening + `rate-cards.ts` in one commit with `local` priced `{0,0,0}`; registry append-last with a regression test; env-gated routing, no DB pref; `json_object` only, never `json_schema`; no schema relaxation of any kind.

### Q1 model options, as presented (kept for the record)

All figures are 4-bit weights on 24 GB unified memory; macOS's default GPU wired limit is ~18 GB, so budget weights + ~1–2 GB KV cache at 16k context.

| LM Studio search | Quant | ≈ RAM | Thinking mode | Verdict |
|---|---|---|---|---|
| **`qwen/qwen3-14b`** | Q4_K_M or MLX-4bit | **~9 GB** | **hybrid — must be turned OFF** | **Recommended.** Strong nested-JSON adherence, ~9 GB leaves real headroom for Chrome + the app. |
| `mistralai/mistral-small-3.2-24b-instruct-2506` | Q4_K_M | ~14.5 GB | none | Best instruction-following of the four, no thinking trap — but ~16 GB with KV cache is tight; close heavy apps first. |
| `google/gemma-3-12b-it` | Q4_K_M | ~8 GB | none | Lightest, no thinking trap, weakest at deeply nested JSON. |
| `openai/gpt-oss-20b` | MXFP4 | ~12 GB | reasoning channel | Fast MoE, but the reasoning channel adds a response-shape variable I would rather not introduce on datapoint #1. |

> **The thinking trap, stated plainly:** if you load Qwen3-14B with thinking enabled, every reply begins with `<think>…</think>` and `JSON.parse` fails on the whole response — each run burns its one retry and then fails. That would be measured as a 100% retry rate and would be *wrong*. Turn thinking off in the model's load settings before the first run. If you would rather not manage that toggle, pick Mistral Small 3.2 or Gemma 3.

---

## What I will need you to do (after approval, before Task 6)

1. **LM Studio → Developer → Start Server.** Port **1234**. Load **`qwen/qwen3-14b`** (Q4_K_M or MLX-4bit) **with thinking mode OFF**. Set **context length 16384** (the executor asks for up to 5 000 output tokens; a 4096 default will hard-fail every run). Disable auto-unload/idle-eject so the model survives 10 sequential runs.
2. **Get the exact model id** and send it to me:
   ```
   curl -s http://127.0.0.1:1234/v1/models | python3 -c 'import json,sys;[print(m["id"]) for m in json.load(sys.stdin)["data"]]'
   ```
3. **Append to the repo-root `.env`** (the file `apps/api/src/env.ts` loads — *not* Railway, which stays exactly as it is):
   ```
   NEXUS_LOCAL_AI_BASE_URL=http://127.0.0.1:1234/v1
   NEXUS_LOCAL_AI_MODEL=<the id from step 2>
   NEXUS_LOCAL_AI_FEATURES=agent-fleet-analyst
   NEXUS_LOCAL_AI_TIMEOUT_MS=300000
   # only if your server demands one — LM Studio ignores it:
   # NEXUS_LOCAL_AI_API_KEY=lm-studio
   ```
   > Use `127.0.0.1`, not `localhost`. Node may resolve `localhost` to `::1` first while LM Studio binds IPv4 only — the failure looks like `ECONNREFUSED` against a server that is plainly running.
4. **Confirm `NEXUS_AI_KILL_SWITCH` is unset/false** in that same `.env` — it fails closed before any provider lookup, local included.

---

## Global Constraints

- **Additive only.** Touched existing files: `providers/types.ts` (one union member), `providers/index.ts` (one registry entry + one name check), `rate-cards.ts` (three parameter widenings + one early return), `model-resolver.service.ts` (one env-gated branch). Nothing else. Explicitly untouched: `ads-write-gate.ts`, `approval-gate.service.ts`, `tool-policy.service.ts`, every `services/agent-fleet/*` file, `schema.prisma`, `apps/web`.
- **No behaviour change when the local provider is unconfigured.** `NEXUS_LOCAL_AI_BASE_URL` unset ⇒ `isConfigured() === false` ⇒ `getProvider()` skips it, `getProviderForFeature()`'s new branch returns before reading the allowlist, `priceFor` never sees `'local'`. Regression-tested, not asserted (Task 2 Step 1).
- **No Zod schema is loosened, relaxed, or made optional.** Not in `packages/shared/agent-fleet.ts`, not via constrained decoding (D6), not via a permissive fallback in the executor. A higher retry rate is the finding.
- **No tunnel to Railway.** Production keeps `ANTHROPIC_API_KEY`, keeps its provider resolution, and is not redeployed by this work.
- **Everything stays dark.** `fleet-selftest` remains `enabled=false` / `OFF`; runs happen via `ignoreEnabled: true` (the existing manual run-now path). No cron registered. No `getEngineLevers()` entry (still a Phase D obligation).
- **`apps/api` tsconfig is NOT strict** — `tsc` will not catch null-into-non-nullable, and discriminated-union narrowing does not work in source files. Prefer optional-`undefined` union members over discriminants, as `budget-guard.ts` already does.
- **Commits:** per task, explicit paths (`git commit --only <paths>` — the working tree carries unrelated WIP, incl. ~18 untracked `_acr*.mts` scripts). Prefix `feat(ai):` / `test(ai):` / `docs(naf):`.
- **Gates per task:** `cd apps/api && npx tsc --noEmit`, `npx vitest run <new tests>`. Per phase: `npm run check:drift` (root), `.githooks/pre-push`. `npm run tokens:check` stays red — pre-existing (TECH_DEBT #62, rail vars); no web change here, so it neither improves nor worsens.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `apps/api/src/services/ai/providers/local.provider.ts` (create) | `LocalProvider implements LLMProvider`. `POST {base}/chat/completions`, OpenAI wire shape, no SDK, no new dependency. `costUSD: 0` always. |
| `apps/api/src/services/ai/providers/local.provider.vitest.test.ts` (create) | Wire-shape, jsonMode, usage mapping, zero-cost, error, timeout, URL-normalisation tests (`fetch` stubbed). |
| `apps/api/src/services/ai/providers/types.ts` (modify) | `ProviderName` gains `'local'`. Doc comment records why the union is now three. |
| `apps/api/src/services/ai/providers/index.ts` (modify) | Import + `local` registry entry **appended last**; `isValidProviderName` accepts `'local'`. |
| `apps/api/src/services/ai/providers/index.vitest.test.ts` (create) | Registry-order regression, kill-switch precedence, `isValidProviderName`. |
| `apps/api/src/services/ai/rate-cards.ts` (modify) | Three signatures widened to `ProviderName`; `local` ⇒ `{0, 0, known:true}`. |
| `apps/api/src/services/ai/rate-cards.vitest.test.ts` (create) | Local prices at zero and is *known*; existing lookups byte-identical. |
| `apps/api/src/services/ai/model-resolver.service.ts` (modify) | One env-gated local-feature branch in `getProviderForFeature`, plus `localFeatureRouting()` exported for testability. |
| `apps/api/src/services/ai/model-resolver.service.vitest.test.ts` (create) | Routing precedence matrix (kill switch > locked > explicit request > local allowlist > pref > global > env). |
| `apps/api/scripts/_naf-a2-bakeoff.mts` (create — **committed**, ACR style) | Sequential N-run harness over `executeCharter`; prints the acceptance evidence chain and the retry-rate table. |
| `docs/2026-08-06-naf-a2-local-provider.md` (this file) | Plan, then the filled acceptance matrix + datapoint #1. |
| `docs/2026-08-06-naf-a-foundation.md` (modify, final task) | Its pending acceptance row flipped, pointing here for evidence. |

---

### Task 1: the local provider (TDD)

**Files:** create `apps/api/src/services/ai/providers/local.provider.ts`, `local.provider.vitest.test.ts`.
**Interface:** exactly `LLMProvider` — no additions, no options bag of its own.

```ts
export class LocalProvider implements LLMProvider {
  readonly name = 'local' as const
  readonly defaultModel: string                 // NEXUS_LOCAL_AI_MODEL, read per-call (never frozen at import)
  isConfigured(): boolean                       // !!NEXUS_LOCAL_AI_BASE_URL
  generate(o: GenerateOptions): Promise<GenerateResult>
}
```

Request: `POST {base}/chat/completions` with `{ model, messages: [{role:'user', content: prompt}], temperature: o.temperature ?? 0.6, max_tokens: o.maxOutputTokens ?? 4096, ...(o.jsonMode && { response_format: { type: 'json_object' } }) }`, headers `content-type` + `authorization: Bearer <key ?? 'local'>`, `signal: AbortSignal.timeout(TIMEOUT_MS)`. Response: `text = json.choices[0].message.content ?? ''`; `inputTokens = json.usage?.prompt_tokens ?? 0`; `outputTokens = json.usage?.completion_tokens ?? 0`; `model = json.model ?? modelName`; `costUSD: 0`.

- [ ] **Step 1: failing test** — `isConfigured()` false with env unset, true with base URL set; POST body carries model/messages/temperature/max_tokens; `jsonMode:true` adds `response_format:{type:'json_object'}` and `jsonMode` absent omits it entirely; usage maps `prompt_tokens`/`completion_tokens`; **`costUSD` is exactly `0`** even with large token counts; response `model` wins over the requested id; missing `usage` ⇒ zeros, not `NaN`; non-2xx throws `Local AI error <status>: <body slice>`; base URL with a trailing slash produces exactly one `/`; an aborted request surfaces a timeout-shaped error; **`generate()` with no base URL throws rather than fetching**.
- [ ] **Step 2: run, verify fail** — `cd apps/api && npx vitest run src/services/ai/providers/local.provider.vitest.test.ts`.
- [ ] **Step 3: implement** — mirror `anthropic.provider.ts` structure and comment density; header comment states the L9 rationale, the OpenAI-compatible target set (LM Studio / Ollama / vLLM / llama.cpp), the D6 decision on `response_format`, and that zero cost is *exact*, not a placeholder.
- [ ] **Step 4: run, verify pass** + `npx tsc --noEmit`.
- [ ] **Step 5: commit** — `git commit --only apps/api/src/services/ai/providers/local.provider.ts apps/api/src/services/ai/providers/local.provider.vitest.test.ts -m "feat(ai): local OpenAI-compatible provider — fetch-only, zero-cost, no SDK (L9)"`.

---

### Task 2: registry + union + rate cards (one commit — they cannot compile apart)

**Files:** modify `providers/types.ts`, `providers/index.ts`, `rate-cards.ts`; create `providers/index.vitest.test.ts`, `rate-cards.vitest.test.ts`.

- [ ] **Step 1: failing tests** —
  - *index:* `isValidProviderName('local')` true; **with `GEMINI_API_KEY` and `NEXUS_LOCAL_AI_BASE_URL` both set, `getProvider()` returns `gemini`** (V4 regression — the whole "no behaviour change" claim rests on this one assertion); with only the local base URL set, `getProvider()` returns `local`; `getProvider('local')` honours an explicit request; kill switch on ⇒ `null` even with local configured; `listProviders()` includes local with its `configured` flag.
  - *rate-cards:* `rateInfoFor('local', anything)` ⇒ `{0, 0, known: true}`; `priceFor('local', m, 1e6, 1e6) === 0`; existing Anthropic/Gemini lookups (incl. the dated-suffix strip and the unknown-model `known:false` fallback) return exactly what they returned before.
- [ ] **Step 2: run, verify fail.**
- [ ] **Step 3: implement** — union member; registry entry appended **after** `anthropic` with an inline comment stating that position is load-bearing; `isValidProviderName` third arm; `rate-cards` widened with the `local` early return.
- [ ] **Step 4: run, verify pass** + `npx tsc --noEmit` — expect V3's two call sites to now compile untouched. **If either still errors, stop and report rather than editing `cost-preview`/`budget`.**
- [ ] **Step 5: commit** — `feat(ai): register local provider — ProviderName union, registry (last), zero rate card`.

---

### Task 3: feature routing through model-resolver (TDD)

**Files:** modify `model-resolver.service.ts`; create `model-resolver.service.vitest.test.ts`.

```ts
/** Feature keys the local provider may serve, from NEXUS_LOCAL_AI_FEATURES
 *  ('*' = all). Read per call, never cached — it is a laptop-only switch. */
export function localFeatureRouting(feature: string): boolean
```

Inserted into `getProviderForFeature` between the explicit-`requested` check and the pref lookup:

```
kill switch → lockedProvider → explicit requested → [NEW: local allowlist, only if local.isConfigured()] → per-feature pref → global pref → env / first configured
```

- [ ] **Step 1: failing test** — `NEXUS_LOCAL_AI_FEATURES=agent-fleet-analyst` + local configured ⇒ `getProviderForFeature('agent-fleet-analyst')` is the local provider; `'listing-content'` under the same env is **unchanged**; env unset ⇒ unchanged for every key; **env set but local NOT configured ⇒ unchanged** (fail-safe: a typo'd base URL must not black-hole a feature); `'*'` routes every non-locked key; whitespace/casing tolerated in the list; a `lockedProvider` feature (`image-vision`) still goes to Gemini even when listed; an explicit `requested:'anthropic'` still wins; kill switch still returns `null`. Mock `db.js` so no pref read happens.
- [ ] **Step 2: run, verify fail.** — [ ] **Step 3: implement.** — [ ] **Step 4: run, verify pass.**
- [ ] **Step 5: typecheck + commit** — `feat(ai): route named AI feature keys to the local provider via env allowlist`.

---

### Task 4: gates

- [ ] **Step 1:** `cd apps/api && npx vitest run src/services/ai src/services/agent-fleet` — the 4 new files green **and the 58 existing fleet tests unchanged** (the executor's provider mocks must still behave identically).
- [ ] **Step 2:** `cd packages/shared && npm test` (unchanged, but proves nothing leaked).
- [ ] **Step 3:** `npx tsc --noEmit` in `apps/api`; `npm run check:drift` at root (no schema change ⇒ must be 0 drift).
- [ ] **Step 4:** report the gate output verbatim in this doc's verification section. No commit (nothing new to commit).

---

### Task 5: the bake-off harness

**Files:** create `apps/api/scripts/_naf-a2-bakeoff.mts` — **committed**, ACR style (`_`-prefixed and tracked, like the 944 scripts already in git).

Pattern: `_nafa-verify.mts` — `await import('../src/db.js')` after `env.ts`, no Fastify boot, no cron. Arg `--runs=N` (default 10).

Per run: `executeCharter('fleet-selftest', { trigger:'manual', mode:'ask', ignoreEnabled:true })`, then read back `AgentRun` + its `AgentStep` rows. Sequential, never parallel — concurrent runs would race the observation upsert and muddy acceptance (b).

Prints:
1. **Per run:** runId, status, ok, model, provider, cost, latency, `#model` steps, `#validation` steps, first-validation `ok`, findingCount.
2. **Observation reuse:** the `id` from every run's observation step + its `cached` flag — acceptance (b) read straight off the trace.
3. **Findings:** total `AgentFinding` rows for `charterKey='fleet-selftest'` after each run, plus the distinct `(entityId, dedupeKey)` set — acceptance (c), and the Q4 evidence.
4. **Retry table:** runs, first-pass count, retried count, twice-failed count, retry rate, hard-failure rate, and the top Zod issue strings taken from failed `validation` steps' `errorMessage` — acceptance (e).
5. **Negative control:** on the final pass, force `expiresAt` into the past on the `cron-health` row, run once more, and assert a **new** observation id — proving the cache is genuinely TTL'd rather than merely sticky.

- [ ] **Step 1: write the script.** Read-only against everything except the dark fleet tables.
- [ ] **Step 2: dry-run with `--runs=0`** — proves env/db wiring and prints the resolved provider + model **without calling the model**.
- [ ] **Step 3: commit** — `feat(naf): NAF.A2 bake-off harness — repeatable retry-rate measurement (Phase J seed)`.

---

### Task 6: the live local run

**Prerequisite:** the env block in place, LM Studio serving `qwen/qwen3-14b` with thinking OFF.

- [ ] **Step 0: `<think>` gate (operator requirement).** One raw `curl` to `/v1/chat/completions` before any measurement. If the reply contains `<think>`, **stop and switch to Mistral Small 3.2 24B** — a thinking-mode artefact must not be measured as a reasoning failure. Record the model id and the thinking setting that produced the numbers.
- [ ] **Step 1: single run.** `npx tsx apps/api/scripts/naf-a2-bakeoff.mts --runs=1`. Expect: `provider=local`, `model=<your id>`, `status=done`, `ok=true`, ≥1 `AgentFinding`. **If validation fails twice, report the Zod issues verbatim and stop — do not touch the schema, the contract hints, or the charter prompt to make it pass.** A model that cannot hold the contract is the datapoint (Q4/Q1 may then need revisiting; that is your call, not a code fix).
- [ ] **Step 2: immediate second run** — acceptance (b) (same observation id, `cached:true`) and (c) (finding count unchanged; dedupe keys compared).
- [ ] **Step 3: `--runs=10`** for the retry-rate datapoint (e), plus the negative control.
- [ ] **Step 4: evidence chain** — `npx tsx apps/api/scripts/_nafa-verify.mts` to resolve `evidenceRefs → AgentObservation` and confirm every persisted finding cites a real row.
- [ ] **Step 5: `AgentStep` spot-check** — acceptance (d): every step `costUSD = 0`; the `type:'model'` step's `name` is the local model id; `AgentRun.provider='local'`, `AgentRun.costUSD=0`. And `AiUsageLog` has matching `provider:'local'`, `costUSD:0` rows (proves `logUsage` fired).

> **Task 6b (a bounded HTTP run through the real route) was proposed and then deleted on the operator's ruling (Q2).** The API is never booted in this session; no second cron runner ever competes with Railway.

---

### Task 7: record the result

- [ ] **Step 1:** append a **Verification** section to this doc: the full acceptance table (a)–(e) with run ids and row counts, the retry-rate datapoint block, and the observed `dedupeKey` behaviour.
- [ ] **Step 2:** flip the pending row in `docs/2026-08-06-naf-a-foundation.md`'s acceptance matrix to ✅ with a pointer here, and state plainly that it was closed **on a local model, not on Anthropic** — so the Anthropic path remains unproven end-to-end past the provider call, which is a genuine residual gap, not a closed one.
- [ ] **Step 3:** record the follow-ups discovered here: (i) `json_schema` constrained decoding as an untested Phase J lever (D6); (ii) local runs make the cost-based day budgets inert — a local fleet needs a time/token ceiling (V14); (iii) local provider absent from Settings→Models (D5); (iv) **if `dedupeKey` proves unstable, it becomes a Phase B charter-template requirement — never a retrofit to the shipped Phase A charter** (operator ruling, Q4).
- [ ] **Step 4: commit** — `docs(naf): NAF.A2 — local provider verification + Phase J datapoint #1`. Then **batch push on operator command**.

---

## Acceptance matrix (to be filled by Task 7)

| # | Item | Status | Evidence |
|---|---|---|---|
| a | Finding validated and persisted; run `status=done` | ⏳ | run id, findingCount, `AgentFinding` id(s) |
| b | `AgentObservation` **reused** on a second run within TTL, confirmed **by id** | ⏳ | observation id identical across runs 1–2, `cached:true`; negative control mints a new id after forced expiry |
| c | `AgentFinding_dedupe` holds — an immediate repeat run creates no duplicate | ⏳ | row count before/after; distinct `(entityId, dedupeKey)` set; **key-stability reported separately from constraint-integrity** (Q4) |
| d | `AgentStep` rows carry `costUSD 0` and the local model id | ⏳ | step dump; `AgentRun.provider='local'`; matching `AiUsageLog` rows |
| e | Schema-validation retry rate over ~10 runs | ⏳ | retry table + top Zod issues — **Phase J bake-off datapoint #1** |
| — | No behaviour change with the local provider unconfigured | ⏳ | `providers/index.vitest.test.ts` registry-order test; 58 existing fleet tests unchanged |
| — | Gates: `tsc --noEmit`, vitest, `check:drift` | ⏳ | Task 4 output |

**Datapoint #1 header (for Phase J comparability):** provider `local`, model `<id>`, quant `<q>`, host LM Studio on M5 Pro 24 GB, `jsonMode` fidelity = **`json_object`** (grammar-constrained *validity*, unconstrained *shape*), temperature 0.2, `maxOutputTokens` 5 000, schema `analyst-output` + the executor's evidence-integrity check, N = 10, retry policy = 1. Not directly comparable to an Anthropic figure, which gets a prompt-only JSON hint (a weaker guarantee); comparable to Gemini's `responseMimeType`.

---

## Self-Review

- **Scope fidelity:** the two things asked for, in order — provider then run — plus the recording the acceptance items imply. Nothing else is built. The Phase J eval harness, the frozen eval set, and the scheduled bake-off report are explicitly **not** in scope (D0). Phase B is untouched.
- **L9 compliance:** no vendor SDK, no new dependency, no agent code aware of a provider. The executor is not edited; it resolves a provider through `model-resolver` exactly as it does today and cannot tell the difference. Adding a provider was a config change plus one file — which is the claim L9 makes, now tested rather than asserted.
- **Constraint audit:** no Zod schema is touched, and D6 refuses the one mechanism that would have inflated the pass rate. `ads-write-gate.ts` / `approval-gate.service.ts` / `tool-policy.service.ts` are not in the file list. No Railway tunnel; production is not redeployed and keeps its Anthropic key. `enabled=false` throughout; no cron. Additive-only, no migration.
- **The one invasive act, and why it is safe:** widening `ProviderName` is the only change that reaches beyond new files. It is contained by (i) appending `local` last in the registry so `getProvider()`'s "first configured" outcome is unchanged (V4 — the explicit regression test in Task 2), and (ii) widening `rate-cards` in the same commit so the two variable-typed call sites (V3) keep compiling untouched.
- **Honest residuals, stated rather than buried:** closing (a) on a local model does **not** prove the Anthropic path end to end — that stays open until the account is funded, and Task 7 Step 2 says so in the predecessor doc rather than quietly ticking a box. Local's zero cost makes both day-budget guards inert (V14), which this plan records rather than fixes. And acceptance (c) can be muddied by model-side `dedupeKey` drift (V10/Q4), so the write-up separates "the constraint held" from "the keys were stable" instead of collapsing them into one tick.
- **Risks:** (1) the thinking-mode trap (Q1) would fake a 100% retry rate — called out with the fix rather than left to be discovered mid-run; (2) a 4096-token context default in LM Studio hard-fails every run against a 5 000-token `max_tokens` — hence the explicit 16384 instruction; (3) `localhost` → `::1` resolution masquerades as a dead server — hence `127.0.0.1`; (4) `npm run dev` contaminating `cron-health` and competing with Railway's cron runner (V13) — the reason for D8, and the reason Task 6b is bounded to ~3 minutes if you overrule it; (5) concurrent sessions on `main` — commits use `--only`, and pre-push builds the working tree, so the batch push happens on a coordinated tree.

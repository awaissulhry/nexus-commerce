# E1 — Shared Ads Core (extraction + shared primitives)

> eBay Ads workstream, Phase E1. Per the E0 gate decision: the shared Ads Core = the existing UM/Marketing-OS seam, **finished and tested**, plus the pure primitives both channels need. The Amazon Trading Desk hot path is untouched except for import re-points to moved pure modules.

## What shipped

### 1. `apps/api/src/services/ads-core/` — the shared home

| Module | Origin | Contents |
|---|---|---|
| `metrics-math.ts` | **moved verbatim** from `services/advertising/ads-metrics-math.ts` | `microsToCents` (sum-then-round), `toEurCents` (FX to EUR base), `allocate` (largest-remainder integer allocation) |
| `date-range.ts` | **moved** from `services/advertising/ads-date-range.ts` **+ new `priorRange()`** | Rome-anchored presets (today…lifetime, windowDays back-compat), `bucketFor`, and the new "vs previous period" equal-length comparison window (`priorRange`) |
| `campaign-status.ts` | **new** (single-sources the adapters' local maps) | normalized status vocabulary (DRAFT/SCHEDULED/ACTIVE/PAUSED/SUSPENDED/ENDED/DELETED), `AMAZON_CAMPAIGN_STATUS_MAP` + `EBAY_CAMPAIGN_STATUS_MAP` (byte-identical to the adapters' previous behavior), `normalizeCampaignStatus`, `canTransitionCampaignStatus` (blocks resume-of-ENDED etc.), `isTerminalCampaignStatus` |
| `quota-ledger.ts` | **new** (closes the E0 "in-process limiter" gap) | fixed-window distributed quota ledger: `QuotaLedger.reserve()` with `MemoryQuotaStore` (tests/fallback) + `RedisQuotaStore` (lazy client injection, INCR+TTL); failMode `closed` (default) / `open`; built for the verified eBay budgets (reports 200/hr/seller, Marketing-Ads 10k/day/app, budget updates 15/day/campaign) |
| `report-task-pipeline.ts` | **new** (the async report contract) | report-task state machine (PENDING→IN_PROGRESS→SUCCESS→INGESTED; FAILED/EXPIRED terminal; retries are NEW tasks), `pollOrder` fairness (never-polled first, then oldest-polled), `ReportTaskDriver<TSpec,TRow>` interface encoding the idempotent-create + absolute-upsert contract. The Amazon pipeline is deliberately NOT refactored onto this (E0 audit: highest regression risk) — E2's eBay pipeline is its first implementer |

### 2. Import re-points (move, don't fork — no shims left behind)

- `routes/advertising.routes.ts` — 1 static `metrics-math` import + **10 dynamic `date-range` imports** re-pointed
- `jobs/advertising-rule-evaluator.job.ts` — `metrics-math`
- `services/advertising/{ads-reconcile, ads-anomaly-guard, ads-detail-metrics, ads-top-of-search}.service.ts` — `metrics-math`
- `services/marketing/adapters/{ebay,amazon}.adapter.ts` — local `STATUS_MAP` consts replaced by imports from `ads-core/campaign-status` (mapping unchanged, now single-sourced; the `scripts/um2-amazon-backfill.mjs` mirror is noted in-code to converge next time it's touched)
- old module files deleted (no re-export shims — shims are the fork-drift hazard the E0 audit flagged)
- `apps/web/.../advertising/_shared/DateRangePicker.tsx` — comment path reference updated (comment-only)

### 3. Characterization tests over the previously-untested seam

- `services/marketing/adapters/ebay.adapter.vitest.test.ts` — pins `normalizeEbayCampaign` (STANDARD→BID_PCT, ADVANCED→DAILY cents, status map + DRAFT fallback, EUR default), adapter registration + capabilities, **write paths throw** (safety posture), `pullMetrics → []`
- `services/marketing/marketing-write-gate.vitest.test.ts` — pins DEFAULT-CLOSED (no env → sandbox), `NEXUS_MARKETING_WRITES_EBAY=1` → live, per-write value cap (default €500, env-overridable), other channels closed
- `services/marketing/adapters/registry.vitest.test.ts` — register/resolve/list, last-registration-wins

## Zero-regression evidence

- **Typecheck:** `npx tsc --noEmit` in `apps/api` — clean (it was tsc that caught the 11 dynamic-import sites a text search missed; all re-pointed).
- **Tests:** targeted suites 71/71 green (`npx vitest run src/services/ads-core src/services/marketing`); full api suite **1445 passed / 1 failed + 1 collection error — both failures pre-existing and unrelated** (proof: vitest isolates per test file, and both files fail when run alone, without any E1 module in their import graphs):
  - `src/services/__tests__/bulk-action-sse.test.ts` — collection error: its `vi.mock('@nexus/database')` provides no `default` export (mock-shape drift vs the package export). P-RT.9 vintage.
  - `src/services/__tests__/amazon-exact-mirror.test.ts` — one image-feed assertion (delete ops carrying `value`); IM-series subject, untouched by E1.
  Both filed in the E1 gate summary as pre-existing findings.
- **Behavior:** moved modules are pure and byte-identical (metrics-math verbatim; date-range verbatim + additive `priorRange`); status maps byte-identical, now imported. No schema change, no env change, no `index.ts` change, no eBay/Amazon API call added or altered.

## Manual checklist (post-deploy spot check)

1. `/marketing/ads/campaigns` loads; date presets behave as before (routes now import `ads-core/date-range`).
2. `/marketing/campaigns` (UM cockpit) roster renders; eBay lens still shows the (empty until re-consent) eBay set.
3. `/api/advertising/*` campaign detail + reconcile endpoints respond (consumers of `metrics-math`).
4. Rank/dayparting crons unaffected (no changes under `jobs/` beyond the rule-evaluator import line).

## How E2 consumes this

- eBay entity/report sync budgets every call through `QuotaLedger` (`RedisQuotaStore` over the BullMQ redis connection).
- `EbayAdsReportTask` implements `ReportTaskDriver`; its poller uses `pollOrder`; facts roll up via `microsToCents`/`toEurCents`.
- The eBay console's range picker resolves via `resolveRange` + `priorRange` server-side.
- eBay mutations validate transitions via `canTransitionCampaignStatus` before enqueueing, and route through `checkMarketingWriteGate` (now characterization-tested).

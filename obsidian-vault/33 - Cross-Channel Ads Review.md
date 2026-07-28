# Cross-Channel Ads Review — Amazon (AX) + eBay (EA/E)

→ [[00 - Nexus Commerce MOC]] | [[34 - Enterprise Ads Benchmark]] | [[30 - Amazon Ads Platform Audit]]

Review date: 2026-07-28, read from the repo zip at commit `fd5c27260`. Every finding below was verified in source. Where a doc and the code disagree, **the code wins** and it is called out.

---

## 0. Headline

Since the last audit the team shipped a great deal: AX-IE.0–.8, AX-ZD.4/.5, AX2.9/AX2.10, and on the eBay side the full E0–E7 / ER / EV series. `ads-core/` now exists as a pure, unit-tested layer. The eBay margin engine and quota governor are genuinely good — better than most of the commercial market.

Three things are true at once, and they need saying plainly:

1. **Two live-impacting defects are shipping right now.** eBay's `SYSTEM_PAUSED` blindness silently zeroes every automation rule and KPI; Amazon's preview/apply field mismatch silently discards operator edits *while reporting success*.
2. **Several AX-ZD phases are recorded as gated but read as done.** The typed mutation queue, the change-stream datasets and the three-state model do not exist. Data vintage exists and has **zero enforcement call sites**.
3. **The programme has built two of everything.** Two rules engines, two rollback implementations, two drift detectors, two API clients, two write gates, two report pipelines, two automation-state tables, two bulk paths. `ads-core/` was the intended seam; of its 14 modules only **two** are genuinely bi-channel.

---

## 1. Defects to fix before anything else

### D1 — eBay `SYSTEM_PAUSED` invisibility · **BROKEN, live**

`EbayCampaign.status` stores eBay's raw string (`ebay-ads-entity-sync.service.ts:72`), but `EBAY_CAMPAIGN_STATUS_MAP` (`ads-core/campaign-status.ts:28-34`) knows only `RUNNING|PAUSED|ENDED|SUSPENDED|DRAFT`. Meanwhile **15+ call sites filter on the literal `{ in: ['RUNNING','PAUSED'] }`**: `ebay-ads.routes.ts:128,441,1052`; `ebay-ads-dashboard.service.ts:45,49`; `ebay-ads-builder.service.ts:62,121`; `ebay-ads-automation.service.ts:277,364,694,737,827,838,875`.

The repo's own account-health message says eBay has set this account's campaigns to `SYSTEM_PAUSED` (`ebay-ads.routes.ts:986`; `ads-core/ebay-error.ts:54`).

**Consequence:** coverage KPI reads 0%, the products rollup shows nothing promoted, the builder's conflict preflight misses every existing ad, and **every automation rule evaluates zero candidates** — silently, with no error anywhere. `_lib/status.ts:7-16` has no `SYSTEM_PAUSED` pill either, so the UI renders a raw grey string.

### D2 — Amazon preview promises what apply silently drops · **BROKEN, silent data loss**

`CAMPAIGN_FIELDS` includes `Campaign name` and `Portfolio ID` (`bulksheet/preview.ts:81`); `ADGROUP_FIELDS` includes `Ad group name` (`:82`). They render as `UPDATE` diffs in the preview. But `apply.ts:125-147` maps only `status`, `dailyBudget`, `biddingStrategy`, and `:148-163` only `status`, `defaultBidCents`. `CampaignPatch` *does* support `name`/`portfolioId` (`ads-mutation.service.ts:202-210`) — they are simply never set.

**Consequence:** an operator who edits budget **and** name in one row gets `APPLIED`, `_status: ok`, and a refreshed `_baseline`. The rename is gone and the file now says it succeeded.

Same class: `Start date`, `End date`, `Match type`, `Keyword text`, `Percentage`, `Native language *`, `Sites`, `Shopper Cohort *` are editable in the schema and validated, but appear in no `*_FIELDS` list, so edits silently report `UNCHANGED`.

### D3 — `EBAY_GB` marketplace mapping · **BROKEN**

Six ad-hoc SHORT maps exist; three are wrong. `ebay-ads.routes.ts:632` yields `undefined` with no fallback, so `getLiveEbayItemIds(pid, undefined)` (`ebay-listing-index.service.ts:276,285`) drops the marketplace predicate entirely and **can resolve Italian item IDs into a GB campaign**. `:650` and `ebay-ads-automation.service.ts:282,562` silently fall back to `'IT'`. The UI can't even select GB (`_lib/presets.ts:6-12`), so the API half-supports a marketplace the console cannot reach.

### D4 — Annotated workbook marks the wrong cells · **BROKEN**

Validation computes `cellAddress` from the *uploaded* sheet's header index (`import-validate.ts:228-232,406-411`), but `annotate.ts:162-167` decodes that column letter back through the *canonical* `COLUMNS[n-1]`. The importer explicitly supports reordered and extra columns (`import-validate.ts:192-194`) — so on exactly the files it advertises support for, the error highlight lands on an unrelated column.

### D5 — `Entity` dropdown exceeds Excel's 255-char limit · **BROKEN**

`spreadsheet-adapter.ts:222` builds an inline `"a,b,c…"` list; the 16 entity values (`ads-bulksheet.ts:87-93`) produce a **278-character** formula. Excel repairs or drops validations over 255 chars — and a repair prompt on open taints the whole workbook. This is exactly what the `Lists` sheet + named ranges were meant to solve, and neither was built.

### D6 — Formula escaping corrupts the round trip · **BROKEN**

`escapeFormulaInjection` (`spreadsheet-adapter.ts:124-126`) prepends a literal `'` to the *value* without setting ExcelJS's `quotePrefix` style. A campaign named `-50% Sale` exports as the literal string `'-50% Sale`. The baseline is hashed **pre-escape** (`build-workbook.ts:184`), so a re-upload reads back a different name than the one that was hashed.

### D7 — `EbayAdsRule.guardrails` is write-only

Stored, versioned (`schema.prisma:12040,12073`), round-tripped and editable in `RuleEditor.tsx` — and **never read during evaluation**. Operators editing it get no behaviour change. Either wire it or rename the field to "notes".

---

## 2. Amazon — AX-IE and AX-ZD status

### DONE, and done well

- **53-column SP layout**, order-for-order identical to the real download recorded in `docs/AMAZON-BULKSHEET-SCHEMA.md:64-116`.
- **9 entity types** exported incl. Bidding adjustment, Product ad, and all five target flavours (`advertising.routes.ts:4348-4374`).
- **`_row_key` / `_baseline` / `_meta`** with a per-field FNV-1a hash over a per-entity field list, normalised through the schema first (`ads-bulksheet.ts:508-521,541-572,597-609`). Performance columns excluded by construction. Sound design.
- **Import defence-in-depth:** magic-byte sniff, then a hand-rolled ZIP central-directory walk refusing >512 entries / >600 MB uncompressed / ZIP64 (`import-validate.ts:96-145`). `.xlsm` refused.
- **Streaming import parse** with a detected fallback for the ExcelJS part-ordering bug, size-bounded at 8 MB (`spreadsheet-adapter.ts:338-390`; `import-validate.ts:327-343`). Genuinely good engineering.
- **Two-pass validate-then-apply** with real staging columns `planToken`/`planComputedAt`/`planSummary` (`schema.prisma:6018-6020`) and a plan-token handshake that refuses on mismatch (`advertising.routes.ts:4666-4675`).
- **Dry-run preview** with field-level diff, blast radius written as consequences not counts, and conflict detection recomputed from live state scoped to touched fields (`preview.ts:115-370,247-262`).
- **Annotated workbook** that genuinely **refreshes `_baseline` from a re-read of the entity** post-apply (`annotate.ts:85-131,191-192`) — the correction loop really does close.
- **Rollback** via `rollbackByChangeSetId`, newest-first (`rollback.service.ts:170-209`).
- **Italian locale handled properly:** `parseMoney` accepts `1.234,56` and `1,25` and **rejects** ambiguous `1,234` naming both readings (`ads-bulksheet.ts:298-310`). The €0.50 silent default is gone — `parseBid` errors instead (`:312-319`). it-IT enum aliases present (`:117,126,133`).
- **Token expiry tracked:** `tokenIssuedAt`/`tokenExpiresAt`/`tokenIssuedAtIsEstimate` stamped at consent (`schema.prisma:2911-2913`; `amazon-ads-auth.routes.ts:390-422`), with a `critical ≤30d` band surfaced (`advertising.routes.ts:7750-7765`).
- **Canonical model decision made and documented in three places**, including in-schema warning blocks marking Gen B as "SHADOW, not authoritative" (`docs/CANONICAL-ADS-MODELS.md:13-19`; `schema.prisma:13397-13403,13565-13570,13608-13613`). All new code reads Gen A only. Honest and correct.
- **`ads-core/drift.ts`** classifies four states — `WRITE_PENDING`, `WRITE_FAILED`, `WRITE_LAG`, `EXTERNAL_CHANGE` — with a 15-minute lag grace and two asymmetric skips whose motivating production incident is recorded in the file (`:22-30,64-81,126-139`). Rides the existing settings sync at zero extra API cost.

### PARTIAL

- **Truncation is loud now** (`X-Nexus-Export-Truncated`, README banner, `_meta.truncated`) — good. But `productAds`, `adGroups` and portfolios are **unbounded** (`advertising.routes.ts:4262,4396`); only the campaign count is guarded by `HARD_CEILING = 5000`. Worst case is ~5M target rows in memory before ExcelJS starts.
- **Entity×operation support is inconsistent between schema and apply.** `ENTITY_RULES` marks `Product targeting`, `Negative product targeting` and `Campaign negative keyword` as `applySupported: false` (`ads-bulksheet.ts:378-389`), but `apply.ts:164-181` writes them anyway. Genuinely unsupported: `Product ad`, `Bidding adjustment`, `Portfolio`.
- **`Create` is unsupported on the new path entirely** (`apply.ts:113-118`). Creation only exists on the legacy JSON endpoint (`advertising.routes.ts:4890-4993`).
- **Idempotency is weak.** It relies on `ImportJobRow.status === 'SUCCESS'` (`apply.ts:92-95`) with **no unique constraint on `(jobId, rowIndex)`** and **no lock on the apply endpoint** — two concurrent POSTs both pass the plan-token check and both write.
- **Rollback silently expires at 24h** (`rollback.service.ts:181`); the History "Undo" button returns `reversed: 0` with no explanation (`BulkClient.tsx:220`).
- **Drift covers CAMPAIGN only.** `AdDrift.entityType` documents three types (`schema.prisma:3355`) but only `'CAMPAIGN'` is ever written. And the pending-write lookup is a **campaign-wide** JSON-path scan (`ads-campaign-settings-sync.service.ts:110-124`), so one queued mutation classifies *every* drifting field on that campaign as `WRITE_PENDING`.
- **`targetingType` drift can never fire** — it's in `CAMPAIGN_DRIFT_FIELDS` (`:66`) but absent from both the `ours` map (`:88-93`) and the `select` (`:177-181`), so `diffFields` skips it permanently (`drift.ts:150-151`).

### MISSING

- **SB and SD sheets.** Declared deliberate (`build-workbook.ts:15-20`), but worse: **SB/SD campaigns are written onto the SP sheet** (`advertising.routes.ts:4339`), and `ENTITIES_BY_PRODUCT` — which its own comment claims "is what validation uses" (`ads-bulksheet.ts:164`) — is referenced **only from a test**.
- **Portfolios cannot round-trip.** `PORTFOLIO_COLUMNS` (`build-workbook.ts:146-156`) is 9 ad-hoc columns against Amazon's real 12, with no `Entity` column, so the importer skips the sheet (`import-validate.ts:33`).
- **Export is not streamed.** `createWriter()` instantiates a plain `new ExcelJS.Workbook()` (`spreadsheet-adapter.ts:250-253`), not `WorkbookWriter`, so `maybeDrain()` (`:194-204`) is **dead code**. Rows are materialised into `sheetRows` first and the result is `reply.send(buf)`. In-request, synchronous, no `ExportJob`.
- **Sheet protection, named ranges, conditional formatting, `Lists` sheet** — zero hits. The README even instructs the operator about sheet protection that is never applied (`build-workbook.ts:293`).
- **`_row_key` is never used as a join key.** Emitted, parsed, stored and echoed — but `buildPreview` resolves rows exclusively by ID columns (`preview.ts:136-162`). The schema's claim that it is "The ONLY join key on import" (`ads-bulksheet.ts:515`) is false.
- **`apps/web` never imports the shared schema.** Zero hits across `apps/web/src`. The old console keeps its own `validateRow`, its own `ENTITIES`/`OPS` arrays, its own comma-only CSV split and its own 2000-row cap (`ads-console/bulk/BulkOpsClient.tsx:24-25,41-48,93,155`). The new page does no client-side validation at all. **The two-grammar problem AX-IE.2 was built to end still exists.**
- **No server-side CSV path at all** — `/bulk/upload` rejects anything that isn't a ZIP (`advertising.routes.ts:4489-4492`). The only CSV parser is client-side and splits on `,` only, so an Italian Excel CSV (`;`) parses as one column.
- **Progress, resumability, cancellation.** `validateBulksheetStreaming` accepts `onProgress` (`import-validate.ts:315`) and the route never passes it. Background work is a bare `void (async () => …)` (`:4530`); the code admits BullMQ was deferred (`:4527-4528`).
- **AX-ZD.1 typed `AdMutation` queue does not exist** — no such model among 357.
- **AX-ZD.2 change-stream datasets not subscribed.** `AMS_DATASETS` is the six performance datasets only (`ads-marketing-stream.service.ts:33-37`); the header states budget-usage and the campaigns/adgroups/ads/targets streams are intentionally excluded. `ams-sqs-poll.job.ts:35-43` does no dataset routing.
- **AX-ZD.3 intended/observed/reported not in the schema.** `AdDrift` has two value columns, not three.
- **Data vintage has no teeth.** `ads-core/data-vintage.ts` is complete and tested, wired into exports and one endpoint — but **`isRuleSafe` has zero call sites outside its own test**. No rule evaluator, autopilot, bid optimiser or budget path consults it. The module's own stated "one rule with teeth" (`:20-21`) is unenforced. Also no UI: zero hits for `vintage` or `/drift` across the ads web app.
- **`ads-core/quota-ledger.ts` does not govern Amazon at all** — its only consumer is eBay (`ebay-ads-api.service.ts:22`). Nothing under `services/advertising/` imports it.
- **Client hardening absent.** `Retry-After` never read; backoff is deterministic with no jitter (`ads-api-client.ts:226-228`); **423 is a hard failure** (`:226,277`); no per-region bucket; no per-entity write serialization; and a dead unreachable `fetch` at `:233`.
- **API versions unchanged** — SP v3, SB v4, SD v3, legacy `/v2/profiles`. No `/adsApi/v1`.

### Test coverage

44 test files across ads. `ads-core/` is ~1:1. But **every write path in the bulksheet layer is untested**: `apply.ts` (212 lines), `preview.ts` (371), `build-workbook.ts` (302), `spreadsheet-adapter.ts` (390), `annotate.ts` (220) — **no tests at all**. The one bulksheet test covers only the magic-byte sniff, the zip-bomb walk and column-letter maths; neither `validateBulksheet` nor `validateBulksheetStreaming` is exercised end to end, and no fixture workbook exists. `ads-api-client.ts` is 54 KB with a 1.5 KB test.

---

## 3. eBay — EA/E-series status

### DONE, and the strongest work in the programme

- **CPS and CPC lifecycle complete** — create/pause/resume/end/clone, FIXED + DYNAMIC rate strategy, key-based and rules-based campaigns, per-ad rate override, ad groups, keywords, smart and manual targeting (`ebay-ads-write.service.ts:138,159,263,277-281,536,635,651`).
- **`ads-core/ebay-margin.ts` — 210 lines, 16 tests, and the best module in the repo.** Correct fee base `A = price + buyer-paid shipping` (`:66`), `breakEvenAdRatePct = margin ÷ (A × (1+VAT)) × 100` (`:90`), `computeBreakEvenCpcCents` refusing below 50 clicks (`:96-100`), `dataStatus ∈ OK|ESTIMATED|MISSING_COGS|MISSING_PRICE`. Missing COGS ⇒ automation skips entirely (`clampAutoRate:161-163`). Caveats stated in code rather than hidden.
- **Quota governor, done right.** Three ledgers, two budgets, reads fail-open and writes fail-closed with the rationale in comments (`ebay-ads-api.service.ts:36-58`); 9,000/day under eBay's 10,000; 180/hr under 200; **one unit reserved per outbound request including each retry** (`:91-115`) — the subtle point most implementations miss. Plus a separate 15-budget-updates/campaign/day guard enforced our side before eBay's (`ebay-ads-write.service.ts:574-578`).
- **Automation engine with real guardrails:** global OFF/SUGGEST/AUTO dial with `halted`, break-even clamp with no override path, MISSING_COGS skip, per-campaign policy caps/floors/`protected`, per-entity dedupe + cooldown, rule cooldown, and a monthly spend ceiling that **auto-halts the whole channel at 100%** (`ebay-ads-automation.service.ts:161-170,203-222,297,443-448,646-655`), with the kill switch re-checked inside the write service (`ebay-ads-write.service.ts:104-109`). Genuine defence in depth.
- **Dry-run that really is one** — `previewRule` builds real candidates and never invokes the apply closures (`:1113-1125`).
- **Proposals with rollback** — `rollbackProposal` applies a recorded `inverse` through the same audited write path, 7 inverse kinds, refuses anything without an inverse (`:586-632`).
- **Immutable rule versioning** with revert-appends-new-version (`:1136-1178`; `schema.prisma:12062`).
- **Report pipeline** handling eBay's real constraints: `chunkDays: 1` because eBay rejects the `day` dimension (error 35107), `TSV_GZIP` forced (35118), metric keys intersected against live `ad_report_metadata`, `EUR 1.234,56` locale money parser, unknown columns preserved in `extra` with **fail-loud null** when nothing maps, absolute upserts so re-pulls are idempotent across the 72h window (`ebay-ads-reports.service.ts:114-125,220-237`; `ebay-ads-api.service.ts:250,262-267`).
- **Search-query reports handled correctly** — CPC-only, one campaign per task, no `day` dim, trailing-30d dated at `dateTo`, and the route 400s for non-CPC campaigns (`ebay-ads.routes.ts:1341-1367`).

### MISSING

- **The entire `EbayAdPool` abstraction.** Zero hits for `EbayAdPool|adPool|poolId|canonicalSku` in eBay ads code. All seven invariants I1–I7 absent. The nearest thing is a *warning* on one-listing-one-General conflicts (`ebay-ads-builder.service.ts:59-72`) which is per-listing, CPS-only, and filters `fundingModel: 'COST_PER_SALE'` (`:62`) — so **a listing in both a CPS and a CPC campaign is never flagged**, which is precisely the double-fee case. Every decision is made at listing grain. F1 (self-competition), F3 (multiplied attribution tails) and F4 (stockout overspend) are entirely unmitigated.

  To be fair to the team: `docs/ads-ebay/EA-RECONCILIATION-AND-PLAN.md:38-42` correctly identifies that the spec's construction path (`ChannelListing → ProductVariation → canonical SKU`) is unimplementable — `ProductVariation` is a deprecated empty table with no FK from `ChannelListing`, and `Product.sku` is `@unique` so one SKU cannot span two families. I verified that against `schema.prisma` and it holds. The phenomenon is still real via `SharedListingMembership` (`ebay-listing-index.service.ts:290-294`), which the product rollup explicitly ignores. **The reconciliation produced a plan and no code.**
- **`armedUntil` and the 30-day attribution tail.** The window is a *string label* in the UI and payloads (`ebay-ads.routes.ts:148`; `_lib/banners.tsx:40`) and nothing models it. No column, no computation, no job.
- **"Rate at time of sale" appears only in docs.** `estimateImpact` (`ebay-ads-automation.service.ts:130-157`) assumes fees scale linearly and instantly with the rate — explicitly wrong under rate-at-sale, though it does state its assumption.
- **Negative-keyword lifecycle is create-only** — no update, no delete, no re-scope. And there is **no `add_negative_keyword` automation action**, so the harvest loop is manual.
- **Ad group update/delete and keyword delete** missing entirely.
- **Offsite creation** not implemented — honest explainer page instead (`campaigns/new/offsite/page.tsx:2-4`). Promoted Stores correctly out of scope (not in the Sell Marketing API contract).
- **No route tests** for any of the 68 endpoints; **no web tests**; no tests for the CSV import/export despite its header claiming the parsers are unit-tested.

### Other issues

- Report tasks send only `marketplaceIds[0]` (`ebay-ads-api.service.ts:254`) while ingest attributes rows to `task.marketplaces[0] ?? 'EBAY_IT'` (`ebay-ads-reports.service.ts:419`) — a multi-marketplace set mis-partitions.
- Currency hardcoded `'EUR'` across routes, ingest and ceilings.
- `siteId = '101'` hardcoded in listing discovery (`ebay-listing-index.service.ts:49`); new index rows default `marketplace = 'IT'` when the `GetItem` budget is exhausted (`:194`).
- eBay import/export is a **bespoke flat CSV paste-a-textarea path** (`ebay-ads-csv.service.ts`, `_modals/ImportCsvModal.tsx`) with no shared substrate — `packages/shared/ads-bulksheet.ts` contains **zero eBay references**.

---

## 4. The two-of-everything problem

### Genuinely shared

`ads-core/date-range.ts` · `ads-core/campaign-status.ts` · `services/marketing/adapters/*` · the `CampaignAction` audit table · `MarketingCampaign`/`CampaignMetric` · `channel-batch/rate-limit.ts` · and — the strongest sharing in the system — the **web layer**: `AdsDataGrid`, `_grid/format`, `FilterDropdown`, `InfoTip`, `StatusPill`, `AdsPageHeader`, `ads.css`, with ~30 imports from `ads/ebay/**`.

### Duplicated

| Concern | Amazon | eBay |
|---|---|---|
| API client + retry | `advertising/ads-api-client.ts` | `marketing/ebay-ads-api.service.ts` |
| Write gate | `advertising/ads-write-gate.ts` | `marketing/marketing-write-gate.ts` (header claims it "generalizes" the other; Amazon still uses its own) |
| Report pipeline | `advertising/ads-reports.service.ts` | `marketing/ebay-ads-reports.service.ts` |
| Rules engine | `automation-rule.service.ts` + `jobs/advertising-rule-evaluator.job.ts` + `automation-action-handlers.ts` | `marketing/ebay-ads-automation.service.ts` |
| Rule storage | `AutomationRule`/`AutomationRuleExecution` | `EbayAdsRule`/`EbayAdsRuleExecution`/`EbayAdsRuleVersion` |
| Proposals | `ads-suggestions.service.ts` + `AdsRuleSuggestion` | `EbayAdsProposal` inside the automation service |
| Rollback | `advertising/rollback.service.ts` | `rollbackProposal()` inline |
| Anomaly guard | `ads-anomaly-guard.service.ts` | `detectAnomalies()` inline |
| Drift | `ads-write-reconcile` + `ads-sync-integrity` + `ads-core/drift.ts` | `detectDrift()`/`repairDrift()` inline |
| Automation state | `AdsAutomationState` | `MarketingAutomationState` |
| Bulk | `shared/ads-bulksheet.ts` + 7 files | `ebay-ads-csv.service.ts` |
| Margin | `true-profit-rollup` + `ads-target-acos` | `ads-core/ebay-margin.ts` |
| Metrics math | `ads-core/metrics-math.ts` (Amazon-only) | inline `derive()` + `metricValue()` |
| Data vintage | `ads-core/data-vintage.ts` (Amazon-only) | none |
| Web: change log / rules / suggestions / bulk / dashboard / builder | 6 route groups | 6 parallel route groups |

**`ads-core/` holds 14 modules. Two are bi-channel. Seven are Amazon-only, four eBay-only, one is a contract only eBay implements.** The team's own `E0-EXISTING-ADS-AUDIT.md` §5 flagged this hazard; it happened anyway.

Notably, **each channel has invented something the other lacks and would benefit from**:

| Capability | Where it exists | Where it's missing |
|---|---|---|
| Immutable rule versioning | eBay | Amazon |
| Break-even margin clamp on automation | eBay | Amazon |
| Quota ledger with fail-open/fail-closed asymmetry | eBay | Amazon |
| Per-entity cooldown + channel auto-halt | eBay | Amazon |
| Proposal inverse + rollback refusal without one | eBay | Amazon (has change-set rollback instead) |
| Data-vintage ladder | Amazon | eBay |
| Drift classification into four typed states | Amazon | eBay (has ad-hoc `detectDrift`) |
| Change-set rollback across a whole bulk apply | Amazon | eBay |
| XLSX round trip with baseline/conflict detection | Amazon | eBay |
| Structured blueprint/replication | Amazon | eBay |

That table is the roadmap. Almost every gap on one side is already solved on the other.

---

## Related Notes

- [[34 - Enterprise Ads Benchmark]] — the external bar
- [[30 - Amazon Ads Platform Audit]] · [[31 - Amazon Ads Competitor Teardown]] · [[32 - Amazon Ads Import-Export & Sync Spec]] · [[28 - eBay Ads Strategy Research]] · [[29 - eBay Ads Cockpit Spec (EA-series)]]

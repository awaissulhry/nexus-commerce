# Paste-ready Claude Code prompt — cross-channel ads (Amazon AX + eBay EA)

Copy everything below the line into your terminal session at the repo root.

---

We are hardening and unifying the cross-channel ads platform: Amazon (AX series) and eBay (EA/E series).

Three vault documents are the brief. Read all three **in full** before writing any code:

- `obsidian-vault/33 - Cross-Channel Ads Review.md` — engineering review of both channels, read from source, with `path:line` on every finding and a DONE / PARTIAL / MISSING / BROKEN split
- `obsidian-vault/34 - Enterprise Ads Benchmark.md` — Rithum, Pacvue, Skai, Perpetua, CommerceIQ, Channable, Productsup, Salsify, Akeneo. The capability bar, and the fifteen things nobody in the market has
- `obsidian-vault/30 - Amazon Ads Platform Audit.md` — the prior audit, for context on what changed

Also read: `docs/PROJECT-MAP.md`, `docs/CANONICAL-ADS-MODELS.md`, `docs/AMAZON-BULKSHEET-SCHEMA.md`, `docs/AX-IE-0-1-PLAN.md`, `docs/ads-ebay/EA-RECONCILIATION-AND-PLAN.md`, `docs/ads-ebay/E0-EXISTING-ADS-AUDIT.md`, `TECH_DEBT.md`.

Ignore `plans/` and `docs/PHASE*.md` entirely — ~100 files describing work abandoned in April 2026, per `docs/PROJECT-MAP.md`.

## Rule zero — extend, never create a parallel file

Last time a prompt told you to create files that already existed. Do not repeat that. Before creating **any** file, search for its counterpart. These all exist and must be **extended in place**:

| Concern | File |
|---|---|
| Amazon ads HTTP | `apps/api/src/routes/advertising.routes.ts` — **456 KB, 276+ routes**. Contains `€`, so `grep -a`. A duplicate Fastify route registration is a **boot crash**, not a 4xx |
| eBay ads HTTP | `apps/api/src/routes/ebay-ads.routes.ts` — 86 KB, 68 routes |
| Shared bulksheet schema | `packages/shared/ads-bulksheet.ts` — 645 lines, the one grammar |
| Bulksheet engine | `apps/api/src/services/advertising/bulksheet/{spreadsheet-adapter,build-workbook,import-validate,preview,apply,annotate}.ts` |
| Pure ads units | `apps/api/src/services/ads-core/` — 14 modules incl. `drift.ts`, `data-vintage.ts`, `quota-ledger.ts`, `campaign-status.ts`, `ebay-margin.ts`, `report-task-pipeline.ts`, `metrics-math.ts`, `ads-sync-integrity.ts` |
| Amazon API client | `apps/api/src/services/advertising/ads-api-client.ts` |
| eBay API client | `apps/api/src/services/marketing/ebay-ads-api.service.ts` |
| Amazon write path / gate / rollback | `advertising/ads-mutation.service.ts`, `advertising/ads-write-gate.ts`, `advertising/rollback.service.ts` |
| eBay write path | `marketing/ebay-ads-write.service.ts`, `marketing/marketing-write-gate.ts` |
| eBay automation | `marketing/ebay-ads-automation.service.ts` — 1,231 lines |
| Marketing Stream | `advertising/ads-marketing-stream.service.ts` + `jobs/ams-sqs-poll.job.ts` |
| Bulk UI | `apps/web/src/app/marketing/ads/bulk/{page,BulkClient}.tsx` |
| eBay console | `apps/web/src/app/marketing/ads/ebay/**` — 95 files |
| Shared grid | `apps/web/src/app/marketing/ads/campaigns/_grid/AdsDataGrid.tsx` |

## Phase 1 — fix the seven defects. Nothing else until these are done.

Each is verified in source. Two are shipping wrong behaviour to users right now.

**D1 · eBay `SYSTEM_PAUSED` blindness — live, silent, highest priority.**
`EbayCampaign.status` stores eBay's raw string (`ebay-ads-entity-sync.service.ts:72`) but `EBAY_CAMPAIGN_STATUS_MAP` (`ads-core/campaign-status.ts:28-34`) doesn't know `SYSTEM_PAUSED`, while 15+ call sites filter on the literal `{ in: ['RUNNING','PAUSED'] }` — `ebay-ads.routes.ts:128,441,1052`; `ebay-ads-dashboard.service.ts:45,49`; `ebay-ads-builder.service.ts:62,121`; `ebay-ads-automation.service.ts:277,364,694,737,827,838,875`. This repo's own health message says eBay has set this account to `SYSTEM_PAUSED` (`ebay-ads.routes.ts:986`). So: coverage reads 0%, the products rollup shows nothing promoted, the builder's conflict preflight misses every ad, and **every automation rule evaluates zero candidates** — with no error. Add the status to the map, replace every literal filter with a shared `ACTIVE_ISH` predicate exported from `ads-core/campaign-status.ts`, and add the pill to `_lib/status.ts:7-16`.

**D2 · Amazon preview promises what apply drops — silent data loss.**
`preview.ts:81-82` includes `Campaign name`, `Portfolio ID`, `Ad group name` in the diff; `apply.ts:125-163` maps only status/budget/bidding-strategy/defaultBid. `CampaignPatch` already supports `name`/`portfolioId` (`ads-mutation.service.ts:202-210`). Result: edit budget **and** name, get `APPLIED` + `_status: ok` + a refreshed baseline, rename silently gone. Fix by making one list the source of truth — derive the preview's `*_FIELDS` from the apply mapper, so a field that cannot be applied cannot be previewed. Then extend the mapper to cover `Start date`, `End date`, `Keyword text`, `Match type` (as archive+create — it is immutable on Amazon), `Percentage`, and the remaining editable columns, or mark them explicitly non-editable in the schema.

**D3 · `EBAY_GB` mapping.** Six ad-hoc SHORT maps, three wrong. `ebay-ads.routes.ts:632` yields `undefined` → `getLiveEbayItemIds(pid, undefined)` drops the marketplace predicate (`ebay-listing-index.service.ts:276,285`) and **can resolve Italian item IDs into a GB campaign**. `:650` and `ebay-ads-automation.service.ts:282,562` fall back to `'IT'`. Replace all six with one exported constant, and either add GB to `_lib/presets.ts:6-12` or reject it at the API boundary.

**D4 · Annotated workbook highlights the wrong cell.** Validation records `cellAddress` from the *uploaded* header index (`import-validate.ts:228-232,406-411`); `annotate.ts:162-167` decodes it back through the *canonical* `COLUMNS`. On any reordered file — which the importer explicitly supports (`import-validate.ts:192-194`) — the red cell is wrong. Carry the uploaded header map through to annotate.

**D5 · `Entity` dropdown is 278 chars, over Excel's 255 inline limit** (`spreadsheet-adapter.ts:222`, values at `ads-bulksheet.ts:87-93`). Build the `Lists` sheet and named ranges that the spec called for and source every dropdown from them. This also fixes the O(rows × enum-columns) validation-object explosion — ~93k objects at current volume.

**D6 · Formula escaping corrupts the round trip.** `escapeFormulaInjection` (`spreadsheet-adapter.ts:124-126`) prepends `'` to the *value* without setting ExcelJS `quotePrefix`. A campaign named `-50% Sale` round-trips as `'-50% Sale`, and the baseline was hashed pre-escape (`build-workbook.ts:184`). Use `quotePrefix` styling, or strip the prefix on read before comparison.

**D7 · `EbayAdsRule.guardrails` is write-only.** Stored, versioned, UI-editable (`schema.prisma:12040,12073`), never read by the evaluator. Wire it into `candidatesForRule`, or rename the field to "notes" and stop implying it does something.

## Phase 2 — enforce the safety machinery that is already written

This is the highest-value work in the whole plan, because the code exists and does nothing.

**`ads-core/data-vintage.ts` has zero enforcement call sites.** `isRuleSafe` is referenced only by its own test. No rule evaluator, autopilot, bid optimiser or budget path consults it. The module's own comment calls it "one rule with teeth" (`:20-21`). Give it teeth: gate `advertising-rule-evaluator.job.ts`, `ads-autopilot.service.ts`, `ads-bid-optimizer.service.ts` and every budget path on it, and surface `vintageBadge` in the grid and campaign detail. Note the real boundary is `ageDays >= 15` (`:70-80`), not T-4 — make that visible rather than implicit.

**`ads-core/quota-ledger.ts` does not govern Amazon.** Its only consumer is eBay (`ebay-ads-api.service.ts:22`). Amazon relies on bare 429/5xx retry. Extend it with an Amazon budget and wire `ads-api-client.ts` through it. Amazon's limits are **dynamic, regional and shared across all tenants — adding accounts does not raise throughput** — so the bucket must be per-region and global, not per-connection. Copy eBay's fail-open-on-read / fail-closed-on-write asymmetry (`ebay-ads-api.service.ts:36-58`) and its one-unit-per-outbound-request-including-retries accounting (`:91-115`), which is the subtle part most implementations get wrong.

**`ads-api-client.ts` hardening.** `Retry-After` is never read; backoff is deterministic with no jitter (`:226-228`); **HTTP 423 `ConcurrentModificationException` is a hard failure** (`:226,277`) though Amazon marks it retryable; there is no per-entity write serialization; and there's a dead unreachable `fetch` at `:233`. Add all four, with separate retry budgets for 429 and 423.

**Import concurrency.** `apply.ts:92-95` relies on `ImportJobRow.status === 'SUCCESS'` with **no unique constraint on `(jobId, rowIndex)`** and no lock on the apply endpoint — two concurrent POSTs both pass the plan-token check and both write. Add the constraint and a job-level advisory lock.

**Rollback expiry is silent.** `rollback.service.ts:181` filters to a 24h window; the History "Undo" button returns `reversed: 0` with no explanation (`BulkClient.tsx:220`). Surface the window and disable the button past it.

## Phase 3 — unify the two channels

The programme has built two of everything: two rules engines, two rollback implementations, two drift detectors, two API clients, two write gates, two report pipelines, two automation-state tables, two bulk paths, and six parallel web route groups. `ads-core/` was the intended seam — of its 14 modules only **two** (`date-range`, `campaign-status`) are genuinely bi-channel. Seven are Amazon-only, four eBay-only, one is a contract only eBay implements.

**Do not attempt a big-bang merge.** The correct move is a **capability descriptor** that lets one engine serve both channels without pretending they are the same. Build it in `ads-core/` as data:

```
ChannelCapability = (channel, adProduct) → {
  bid: { kind: 'CPC' | 'PERCENT_OF_PRICE', min, max, step, level: 'keyword'|'ad'|'adGroup' }
  budget: { supported: boolean, period, min, max, minDelta, changesPerDay }
  spendBasis: 'CLICK' | 'SALE'
  entities: [...]            // which levels exist
  matchTypes: [...]
  writeSemantics: { immutableFields, archiveIsTerminal, createRequiresParentByName }
  autonomous: [...]          // retailer-driven changes: eBay DYNAMIC rate, Amazon dynamic bidding
  metrics: { supported, provisionalWindowDays, restatementWindowDays }
  limits: { ... }
}
```

Then drive every UI control, validator and rule action from it. **eBay CPS is the case that proves it**: `bid.kind = PERCENT_OF_PRICE` (2.0–100.0), **no budget object**, `spendBasis: 'SALE'`, and the fee is set by the rate **at time of sale, not at click**. It must be excluded from any cross-channel budget pool as `CONTINGENT` rather than `CONTROLLABLE`. No competitor models this correctly, and it is the sharpest claim we can make.

Then port, one at a time, in this order — each is already built on one side:

| Port | From | To |
|---|---|---|
| Immutable rule versioning (`EbayAdsRuleVersion`) | eBay | Amazon |
| Break-even margin clamp on automation (`clampAutoRate`) | eBay | Amazon |
| Per-entity cooldown + channel auto-halt | eBay | Amazon |
| Proposal `inverse` + refusal to roll back without one | eBay | Amazon |
| Data-vintage ladder | Amazon | eBay |
| Four-state drift classification (`ads-core/drift.ts`) | Amazon | eBay (replaces ad-hoc `detectDrift`) |
| Change-set rollback across a whole bulk apply | Amazon | eBay |
| XLSX round trip with `_baseline` conflict detection | Amazon | eBay (replaces the paste-a-textarea CSV modal) |

Almost every gap on one channel is already solved on the other. **That table is the roadmap.**

Also: `apps/web` **never imports `packages/shared/ads-bulksheet.ts`** — zero hits. The old console at `ads-console/bulk/BulkOpsClient.tsx` keeps its own `validateRow`, its own `ENTITIES`/`OPS` arrays, its own comma-only CSV split and its own 2000-row cap (`:24-25,41-48,93,155`). The two-grammar problem AX-IE.2 was built to end **still exists**. Either wire the shared schema into the browser or delete the old console.

## Phase 4 — finish the round trip

### 4a. Close the export-only gap — this is the headline item

The export emits **9 entity types**; the apply path writes **4**. Everything else is a one-way trip: an operator downloads it, edits it, uploads it, and the row is silently skipped. Worse, the declaration and the behaviour disagree **in both directions**.

`ENTITY_RULES` (`packages/shared/ads-bulksheet.ts:379-388`) declares:

| Entity | `applySupported` | What actually happens |
|---|---|---|
| Campaign | `true` | applied |
| Ad group | `true` | applied |
| Keyword | `true` | applied |
| Negative keyword | `true` | applied |
| **Campaign negative keyword** | **`false`** | **applied anyway** — falls into the AdTarget branch (`preview.ts:206`, `apply.ts:164-181`) |
| **Product targeting** | **`false`** | **applied anyway** — same branch |
| **Negative product targeting** | **`false`** | **applied anyway** — same branch |
| **Product ad** (`SKU`/`ASIN` rows) | `false` | genuinely skipped — `UNSUPPORTED` at `preview.ts:237-239`, dropped at `apply.ts:108` |
| **Bidding adjustment** (placement modifiers) | `false` | genuinely skipped |
| **Portfolio** | `false` | genuinely skipped, and the sheet can't be parsed at all |

Two distinct bugs here:

1. **Three entity types are applied while declared unsupported.** They work, but nobody decided that — it is an accident of `preview.ts` routing them into the AdTarget branch. Flip the declarations to `true` and add tests, or gate them properly. Right now the schema lies.
2. **Product ads, bidding adjustments and portfolios are export-only.** These are the SKU/ASIN-level rows and the placement modifiers — the two things operators most want to bulk-edit. `Product ad`'s create key is already declared as `[['SKU','ASIN'], 'Ad group ID']` and its mutate key as `['Ad ID']` (`ads-bulksheet.ts:386`), so the grammar is there; only the apply mapping is missing.

**Wire all three into `apply.ts`:**

- **Product ad** — `Update` (state: enabled/paused/archived) and `Archive` against `AdProductAd` via a new `updateProductAdWithSync` in `ads-mutation.service.ts`, following the existing `updateAdGroupWithSync` shape exactly. `Create` needs SKU-or-ASIN + ad group and belongs with the general Create work below. Note the market context: Perpetua explicitly *cannot* bulk-archive targets or bulk-set placement multipliers, and Adbrew is the only competitor documenting bulk placement-modifier edits — so this is a claim worth being able to make.
- **Bidding adjustment** — placement modifiers already export from `dynamicBidding.placementBidding` (`advertising.routes.ts:4353`). The row key is `(Campaign ID, Placement)` and the value is `Percentage` (0–900). Apply through the existing campaign patch path.
- **Portfolio** — first fix the sheet so it can round-trip at all (below), then support `Update` on name and budget.

Add the invariant test from Phase 6 so a declared-but-unmapped entity can never ship again.

### 4b. Everything else

- **SB and SD sheets.** Today SB/SD campaigns are written onto the **SP sheet** (`advertising.routes.ts:4339`), and `ENTITIES_BY_PRODUCT` — whose own comment claims "this is what validation uses" (`ads-bulksheet.ts:164`) — is referenced only from a test. Give each ad product its own sheet and make `ENTITIES_BY_PRODUCT` load-bearing.
- **Portfolios cannot round-trip** — `PORTFOLIO_COLUMNS` (`build-workbook.ts:146-156`) is 9 ad-hoc columns against Amazon's real 12 with no `Entity` column, so the importer skips the sheet.
- **Export is not streamed.** `createWriter()` uses a plain `new ExcelJS.Workbook()` (`spreadsheet-adapter.ts:250-253`), so `maybeDrain()` (`:194-204`) is dead code and the whole graph is materialised before ExcelJS starts. Move to `WorkbookWriter` with the drain guard (exceljs#2916), and move export to an async `ExportJob` with progress.
- **`productAds`, `adGroups` and portfolios are unbounded** (`advertising.routes.ts:4262,4396`); only campaigns are capped at 5,000. Worst case ~5M rows in memory.
- **`_row_key` is never used as a join key** despite the schema calling it "The ONLY join key on import" (`ads-bulksheet.ts:515`). `buildPreview` resolves solely by ID columns (`preview.ts:136-162`). Use it as the fallback when an ID column has been cleared.
- **`Create` is unsupported on the new apply path** (`apply.ts:113-118`); creation lives only on the legacy JSON endpoint (`advertising.routes.ts:4890-4993`). Consolidate.
- **No server-side CSV path** — `/bulk/upload` rejects non-ZIP (`:4489-4492`). Given the Italian locale, add CSV with **delimiter sniffing** (`;` vs `,`) and the decimal logic already correct in `parseMoney` (`ads-bulksheet.ts:298-310`).
- **Progress, resumability, cancellation.** `validateBulksheetStreaming` accepts `onProgress` (`import-validate.ts:315`) and the route never passes it; background work is a bare `void (async () => …)` (`:4530`). Move to BullMQ as the code itself says was deferred (`:4527-4528`).
- **Sheet protection, named ranges, conditional formatting** — none implemented, and the README instructs operators about protection that is never applied (`build-workbook.ts:293`).

## Phase 5 — the enterprise envelope

From the benchmark: across six enterprise ad suites, **nobody** has per-user spend ceilings, blast-radius caps, rule dry-run against history, change-set revert, rule-version attribution, retailer-autonomous change detection, vintage-aware metric rendering, a sandbox, canary rollout, fiscal-calendar budgets, a published SLA, correct non-CPC modelling, audit export, or a structure linter. We already hold working fragments of nine of those.

Build, in this order:

1. **`AdContext`** — a generalised Amazon profile: credentials, RBAC scope, currency, timezone, rate-limit bucket, billable state, marketplace. Hierarchy, permissions, budgets and rate limiting all resolve off this one object. Copy Pacvue's billable/managed state with soft-delete and re-attach.
2. **Change set as a first-class versioned object**, splitting *edit* from *publish*. Maker-checker, staging, blast-radius counting, dry-run, rollback and audit all derive from it — and `AdvertisingActionLog` + `rollbackByChangeSetId` is already half of it.
3. **Per-user spend authorisation ceilings** — max daily budget, max bid delta %, max absolute. Constraints on the permission grant. The highest-frequency unanswered RFP question in the market and a small build.
4. **Threshold-gated halt on every bulk apply and rule run** — compute % created / paused / bid-changed, absolute count and **projected daily budget delta**; if any exceeds a threshold settable at org / account / campaign-type level with narrower overriding, halt, emit a typed event, notify, require approval. Productsup does this for feeds; nobody in ads does.
5. **Rule dry-run against history** — "show me what this rule would have done over the last 30 days." eBay has `previewRule` for candidates; extend to a historical replay. This is also the strongest sales artefact we can build.
6. **Provenance on every setting** — `source: manual | inherited | rule:<id> | agent:<id> | import:<run>` plus actor and timestamp. Prerequisite for readiness, approvals, undo and AI trust alike.
7. **Channel-readiness scoring** with blocking vs warning tiers, made the **publish gate rather than a report**. Blocking = the channel will reject; warning = will run but underperform.
8. **Centralised channel-feedback inbox with triage state** — sync and async responses, linked to entity + field, 30-day history, snooze 24h/7d/14d/30d, blacklist, purge, 0–1000 severity. Port Productsup's design almost verbatim; the triage state is what keeps it usable past week three.

## Phase 6 — tests

**Every write path in the Amazon bulksheet layer is untested**: `apply.ts` (212 lines), `preview.ts` (371), `build-workbook.ts` (302), `spreadsheet-adapter.ts` (390), `annotate.ts` (220). The single bulksheet test covers only the magic-byte sniff, the zip-bomb walk and column-letter maths — neither `validateBulksheet` nor `validateBulksheetStreaming` runs end to end, and **no fixture workbook exists**. `ads-api-client.ts` is 54 KB with a 1.5 KB test.

eBay has ~139 good unit tests but **zero route tests** across 68 endpoints and **zero web tests**.

Required: a fixture workbook (including one round-tripped through Apple Numbers, which writes structurally different XLSX — different `dimension` refs, sometimes missing `r` attributes), an end-to-end export→edit→import→apply→rollback test, and route tests for the eBay endpoints.

Two invariant tests matter more than any individual unit test, because each makes a whole bug class unrepeatable:

1. **No field may appear in a preview `*_FIELDS` list without a corresponding apply mapping.** Kills D2.
2. **Every entity the exporter emits must either be applied, or be declared `applySupported: false` *and* reach `UNSUPPORTED` in preview — with no third state.** Kills the Phase 4a contradiction where three entity types are applied while declared unsupported, and makes export-only rows impossible to ship silently.

Add a third, cheaper check while you are there: assert that the set of entities in `ENTITY_RULES` equals the set the exporter can emit, so adding a row type to the export without a grammar entry fails CI.

## The eBay pool question — decide it explicitly, do not silently defer again

The EA spec proposed `EbayAdPool` to solve four real failure modes: self-competition in eBay's second-price auction, unattributable ACOS, multiplied 30-day attribution tails, and stockout overspend. **None of it was built**, and `docs/ads-ebay/EA-RECONCILIATION-AND-PLAN.md:38-42` explains why: the spec's construction path (`ChannelListing → ProductVariation → canonical SKU`) is unimplementable because `ProductVariation` is a deprecated empty table with no FK from `ChannelListing`, and `Product.sku` is `@unique`. I verified that against `schema.prisma` and the analysis is correct.

But the phenomenon is real — `SharedListingMembership` (`ebay-listing-index.service.ts:290-294`) is the actual shared-SKU mechanism, and the products rollup explicitly ignores it. Meanwhile the builder's conflict check filters `fundingModel: 'COST_PER_SALE'` only (`ebay-ads-builder.service.ts:62`), so **a listing in both a CPS and a CPC campaign is never flagged** — precisely the double-fee case eBay documents.

So: propose a construction path over `SharedListingMembership` instead of `ProductVariation`, scoped to the two invariants with the clearest payoff — **I3** (never both CPS and CPC on one listing) and **I6** (pool-scoped inventory throttling). If you conclude it is still not viable, say so with evidence and propose the narrower alternative. Do not leave it unaddressed a third time.

## How to proceed

1. Read the three vault documents and the docs listed above.
2. **Do not start coding.** Write an implementation plan for **Phase 1 only** — the seven defects. For each: root cause, every affected call site, the fix, the regression test that would have caught it, and the blast radius of the change.
3. Flag every place these documents disagree with the code. They were written from a read-only review; the source is authoritative.
4. Tell me which of Phases 2–6 you would reorder and why.
5. Wait for my approval before implementing.

One standing instruction: this codebase's comments are unusually honest — several files state plainly what they do not do (`build-workbook.ts:15-20`, `ads-marketing-stream.service.ts:30-32`, `ebay-margin.ts:26-28`). Keep that. When you defer something, say so in the code, not only in a doc.

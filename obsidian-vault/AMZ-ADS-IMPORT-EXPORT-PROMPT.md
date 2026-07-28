# Paste-ready Claude Code prompt — Amazon Ads bulksheet import/export

Scope: **Amazon Ads import/export only.** Not eBay, not the zero-drift work, not the enterprise envelope. Copy everything below the line into your terminal at the repo root.

---

We are finishing the Amazon Ads bulksheet import/export (the AX-IE series). Scope is **only** the bulksheet round trip. Do not touch eBay ads, the AX-ZD drift work, Marketing Stream, or the API client — if you find something wrong there, note it and move on.

Background is in `obsidian-vault/33 - Cross-Channel Ads Review.md` §2 (the Amazon section) and `obsidian-vault/32 - Amazon Ads Import-Export & Sync Spec.md`. Also read `docs/AX-IE-0-1-PLAN.md` and `docs/AMAZON-BULKSHEET-SCHEMA.md`. Ignore `plans/` and `docs/PHASE*.md` — abandoned April 2026.

## Rule zero — extend, do not create

Every file you need already exists. Search before creating anything.

| Concern | File |
|---|---|
| Routes | `apps/api/src/routes/advertising.routes.ts` — **456 KB**. Export at ~`:4235`, upload at ~`:4462`, apply at ~`:4666`, legacy JSON apply at ~`:4890`. Contains `€` → use `grep -a`. **A duplicate Fastify route registration is a boot crash, not a 4xx.** |
| The one grammar | `packages/shared/ads-bulksheet.ts` — 645 lines |
| Engine | `apps/api/src/services/advertising/bulksheet/{spreadsheet-adapter,build-workbook,import-validate,preview,apply,annotate}.ts` |
| Write path | `apps/api/src/services/advertising/ads-mutation.service.ts` (`update*WithSync`), gated by `ads-write-gate.ts` |
| Rollback | `apps/api/src/services/advertising/rollback.service.ts` |
| Job substrate | `ImportJob` / `ImportJobRow` / `ExportJob`, `apps/api/src/workers/bulk-job.worker.ts` |
| UI | `apps/web/src/app/marketing/ads/bulk/{page,BulkClient}.tsx` |
| Legacy console | `apps/web/src/app/marketing/ads-console/bulk/BulkOpsClient.tsx` |

## What is already done — do not rebuild it

The 53-column SP layout matching Amazon's real download · `_row_key`/`_baseline`/`_meta` with per-field FNV-1a hashing over a per-entity field list · magic-byte sniff and the hand-rolled zip-bomb walk · streaming import parse with the ExcelJS part-ordering fallback · two-pass validate-then-apply with `ImportJobRow` staging · the plan-token handshake · dry-run preview with field-level diff, blast radius and `_baseline` conflict detection · the annotated error workbook including post-apply `_baseline` refresh · change-set rollback · Italian locale parsing (`parseMoney` rejects ambiguous `1,234` by design) · all writes routed through `ads-write-gate`.

That is good work. Build on it.

## Part 1 — four defects, in this order

**1. Preview promises what apply silently drops.** `preview.ts:81-82` puts `Campaign name`, `Portfolio ID` and `Ad group name` in the diff; `apply.ts:125-163` maps only `status`, `dailyBudget`, `biddingStrategy`, `defaultBidCents`. `CampaignPatch` already supports `name`/`portfolioId` (`ads-mutation.service.ts:202-210`) — they are just never set.

Today an operator who edits budget **and** name in one row gets `APPLIED`, `_status: ok`, and a refreshed baseline. The rename is gone and the file says it worked.

Fix by making one list the source of truth: derive preview's `*_FIELDS` from the apply mapper so **a field that cannot be applied cannot be previewed.** Then extend the mapper to cover the rest of the editable columns — `Start date`, `End date`, `Keyword text`, `Percentage`, `Native language *`, `Sites`, `Shopper Cohort *` — or mark them non-editable in the schema. `Match type` is a special case: it is immutable on Amazon, so model it as archive + create, never as an update (the note at `preview.ts:229-236` already explains this to the user; make the behaviour match).

**2. The annotated workbook reddens the wrong cell.** Validation records `cellAddress` from the *uploaded* sheet's header index (`import-validate.ts:228-232,406-411`); `annotate.ts:162-167` decodes that letter back through the *canonical* `COLUMNS`. The importer explicitly supports reordered and extra columns (`import-validate.ts:192-194`) — so on precisely the files it advertises support for, the highlight lands on an unrelated column. Carry the uploaded header map through to annotate.

**3. The `Entity` dropdown is 278 characters, over Excel's 255-char inline limit.** `spreadsheet-adapter.ts:222` builds an inline `"a,b,c…"` list from the 16 entity values (`ads-bulksheet.ts:87-93`). Excel repairs or drops validations over 255 chars, and a repair prompt taints the whole workbook on open. Build the `Lists` sheet and named ranges the spec called for and source every dropdown from them. This also kills the O(rows × enum-columns) validation-object explosion — roughly 93k objects at current volume.

**4. Formula escaping corrupts the round trip.** `escapeFormulaInjection` (`spreadsheet-adapter.ts:124-126`) prepends a literal `'` to the *value* without setting ExcelJS's `quotePrefix` style. A campaign named `-50% Sale` exports as `'-50% Sale`, and the baseline was hashed **pre-escape** (`build-workbook.ts:184`), so re-upload compares against a different string. Use `quotePrefix` styling, or strip the prefix on read before comparison.

## Part 2 — close the export-only gap

**This is the headline work.** The export emits **9 entity types**; apply writes **4**. Everything else is a one-way trip — the operator downloads it, edits it, uploads it, and the row is silently skipped.

Worse, the declaration and the behaviour disagree **in both directions**. `ENTITY_RULES` (`ads-bulksheet.ts:379-388`) says:

| Entity | `applySupported` | Actual behaviour |
|---|---|---|
| Campaign, Ad group, Keyword, Negative keyword | `true` | applied ✓ |
| **Campaign negative keyword** | **`false`** | **applied anyway** — falls into the AdTarget branch (`preview.ts:206`, `apply.ts:164-181`) |
| **Product targeting** | **`false`** | **applied anyway** |
| **Negative product targeting** | **`false`** | **applied anyway** |
| **Product ad** (SKU/ASIN rows) | `false` | genuinely skipped (`preview.ts:237-239` → `apply.ts:108`) |
| **Bidding adjustment** (placement modifiers) | `false` | genuinely skipped |
| **Portfolio** | `false` | genuinely skipped, and the sheet cannot be parsed at all |

Two separate problems:

**2a.** Three entity types are applied while declared unsupported. Nobody decided that — it is an accident of `preview.ts` routing them into the AdTarget branch. Flip the declarations to `true` and add tests, or gate them properly. Right now the schema lies to anyone reading it.

**2b.** Product ads, bidding adjustments and portfolios are export-only — and these are the SKU/ASIN rows and the placement modifiers, the two things operators most want to bulk-edit. The grammar is already declared (`Product ad` create key `[['SKU','ASIN'], 'Ad group ID']`, mutate key `['Ad ID']` at `ads-bulksheet.ts:386`); only the apply mapping is missing.

Wire all three:

- **Product ad** — `Update` (state) and `Archive` against `AdProductAd`, via a new `updateProductAdWithSync` in `ads-mutation.service.ts` following the existing `updateAdGroupWithSync` shape exactly. `Create` needs SKU-or-ASIN + ad group; group it with the Create work in Part 4.
- **Bidding adjustment** — already exports from `dynamicBidding.placementBidding` (`advertising.routes.ts:4353`). Row key is `(Campaign ID, Placement)`, value is `Percentage` (0–900). Apply through the existing campaign patch path.
- **Portfolio** — fix the sheet first (Part 4), then support `Update` on name and budget.

Worth knowing for context: Perpetua explicitly **cannot** bulk-archive targets or bulk-set placement multipliers, and Adbrew is the only competitor documenting bulk placement-modifier edits. This is a claim almost nobody else can make.

## Part 3 — scoped and customisable export

### 3a. There is currently no scoping at all

`GET /advertising/bulk/export` accepts **one parameter: `?limit=`** (`advertising.routes.ts:4236`). The query behind it is `prisma.campaign.findMany({ take: limit, orderBy: { name: 'asc' }, include: {...} })` (`:4255-4265`) — **no `where` clause of any kind.** Every export is the entire account, and the only control is how much of it gets truncated.

The 409 at `:4247` even tells the operator *"Narrow the scope, or pass `?limit=`"* — advising an action the API does not support. There is no scope to narrow.

This is also why the unbounded-query problem in 3b bites: without scoping, "export everything" is the only path, so a large account has no safe option at all.

### 3b. What to add

Accept these on the export endpoint, all optional and combinable:

| Scope | Why |
|---|---|
| `portfolioIds[]` | **Portfolio-specific export** — the natural unit of delegated ownership |
| `campaignIds[]` | Export a working set |
| `adProduct` — SP / SB / SD | Pairs with the per-product sheets in Part 4 |
| `marketplace` / `profileId` | Multi-market accounts; also the right rate-limit boundary |
| `state` — enabled / paused / archived | Default to **excluding archived**; archived is terminal on Amazon and mostly noise |
| **`skus[]` / `asins[]`** | **Product-specific export.** Resolve to the ad groups holding those product ads, then emit the containing campaigns with their full entity tree. This is the request operators make most: *"give me the bulksheet for these 30 ASINs."* |
| `entityTypes[]` | Which `Entity` rows to include — bids-only files are far easier to work in than full trees |
| `includeMetrics` + `dateRange` | The 11 performance columns are optional context, not always wanted |
| `columns` preset | Full Amazon layout vs a lean editing set (ids + the handful of editable fields) |
| **`viewId` / filter predicate** | **"Export exactly what I'm looking at"** from the grid |

That last one deserves emphasis. Making the export equal the visible, filtered, sorted view is the single cheapest thing on this list and it kills an entire class of *"why doesn't the export match the screen"* tickets. It is the most-praised feature in Sellerboard's reviews and essentially nobody else ships it.

**Selection must be a predicate, not an ID list.** "All 12,431 rows matching this filter, except these 12" — model it as `filter + excludeIds[]`. An ID array breaks the moment the set is larger than a page, which is exactly when scoped export matters.

### 3c. Two rules that scoping forces

**Stamp the scope into `_meta` and the README.** The file must say what it contains — which portfolios, which SKUs, which entity types, which date range, and the pull timestamp. Without it, two exports of "the same" account disagree and nobody can tell why.

**A scoped export must round-trip safely, and this is the part that will bite.** Once partial files are normal, absence stops meaning anything. **Never infer deletion from a missing row.** A file scoped to one portfolio must not read as "archive everything else." Make the import read the scope stamp, validate that the uploaded file's scope is coherent, and warn loudly if someone uploads a portfolio-scoped file into what looks like a full-account context. The current default (absence = no-op) is already correct — the risk is that someone later adds a "sync/delete missing" mode without realising scoped exports exist.

## Part 4 — finish the round trip

**SB and SD sheets.** Today SB and SD campaigns are written onto the **SP sheet** (`advertising.routes.ts:4339`), and `ENTITIES_BY_PRODUCT` — whose own comment at `ads-bulksheet.ts:164` claims "this is what validation uses" — is referenced **only from a test**. Give each ad product its own sheet and make `ENTITIES_BY_PRODUCT` load-bearing. SB carries creatives (landing page, brand entity, headline, creative ASINs, ad format); SD has its own targeting entities. Treat them as separate column sets, not as SP with extra fields.

**Portfolios cannot round-trip.** `PORTFOLIO_COLUMNS` (`build-workbook.ts:146-156`) is 9 ad-hoc columns against Amazon's real 12 (`docs/AMAZON-BULKSHEET-SCHEMA.md:38-50`), and has **no `Entity` column**, so the importer skips the sheet as non-data (`import-validate.ts:33`).

**The export is not streamed.** `createWriter()` instantiates a plain `new ExcelJS.Workbook()` (`spreadsheet-adapter.ts:250-253`), not `WorkbookWriter` — so `maybeDrain()` (`:194-204`) is **dead code**, `this.wb.stream` being permanently undefined. Rows are also fully materialised into `sheetRows` first (`advertising.routes.ts:4325`) and returned via `reply.send(buf)`. Move to `WorkbookWriter` with a real drain guard every ~1,000 rows ([exceljs#2916](https://github.com/exceljs/exceljs/issues/2916) — no backpressure), and move export onto an async `ExportJob` with progress.

**Unbounded queries.** `productAds` (`:4262`), `adGroups`, and `amazonAdsPortfolio.findMany` (`:4396`) have no limits; only campaigns are capped (`HARD_CEILING = 5000`). Worst case is ~5M target rows in memory before ExcelJS starts. Truncation is loud where it exists (`X-Nexus-Export-Truncated`, README banner, `_meta.truncated`) — extend the same treatment to these.

**`_row_key` is never used as a join key**, despite the schema calling it "The ONLY join key on import" (`ads-bulksheet.ts:515`). `buildPreview` resolves rows solely by ID columns (`preview.ts:136-162`), so a row whose ID cell was cleared comes back `UNRESOLVED` even though `_row_key` carries the local id. Use it as the fallback resolver.

**`Create` is unsupported on the new apply path** (`apply.ts:113-118` skips every CREATE row). Creation exists only on the legacy JSON endpoint (`advertising.routes.ts:4890-4993`), which handles Campaign/Ad-group Update+Archive and Keyword/Negative-keyword Create and answers everything else with `not supported yet` (`:4993`). Consolidate onto one path and delete the legacy endpoint.

**No server-side CSV path.** `/bulk/upload` rejects anything that is not a ZIP (`advertising.routes.ts:4489-4492`, message: *"CSV support is a separate path"*). The only CSV parser is client-side and splits on `,` only (`BulkOpsClient.tsx:41-48,144-149`) — so an Italian Excel CSV export, which is `;`-delimited, parses as a single column. Add a server CSV path with **delimiter sniffing** (count `,` vs `;` vs `\t` on the header line); the decimal logic in `parseMoney` (`ads-bulksheet.ts:298-310`) is already correct and should be reused as-is.

**Progress, resumability, cancellation.** `validateBulksheetStreaming` accepts an `onProgress` callback (`import-validate.ts:315`) that the route never passes (`:4533`), and `totalRows` is only written when validation finishes (`:4550`) — so a polling client sees `PROCESSING` with `totalRows: 0` for the entire run. The background work is a bare `void (async () => …)` (`:4530`), and the code itself says BullMQ was deferred (`:4527-4528`). Move it onto the existing `bulk-job.worker.ts` substrate, persist `lastProcessedRow` for resume, and add a cancel endpoint.

**Missing workbook features.** Sheet protection, named ranges and conditional formatting are entirely absent — zero hits for `protect|conditionalFormat|definedNames` under `bulksheet/`. The README even instructs the operator about sheet protection that is never applied (`build-workbook.ts:293`). Add: protection with editable cells explicitly unlocked and sort/filter still permitted; named ranges (`AdsData` plus one per dropdown list); and **5–7 conditional formatting rules maximum** — ACOS colour scale, spend data bars, `clicks > 50 AND orders = 0`, bid-above-break-even, paused rows greyed. More than seven and Excel recalculates on every edit until the file feels broken.

Keep Apple Numbers in mind throughout: it silently drops data validation and ignores sheet protection, so both are UX aids and **the server-side validator remains the only real gate**. Do not use a real Excel Table (ListObject) — Numbers handles them worst; use manual banding plus autofilter.

## Part 5 — two correctness fixes in the apply path

**Import concurrency.** `apply.ts:92-95` relies on `ImportJobRow.status === 'SUCCESS'` for idempotency, but there is **no unique constraint on `(jobId, rowIndex)`** in the schema and **no lock on the apply endpoint** — two concurrent POSTs both pass the plan-token check and both write before either marks rows `SUCCESS`. Add the constraint and a job-level advisory lock.

**Rollback expiry is silent.** `rollback.service.ts:181` filters to a 24-hour window; past it the History "Undo" button returns `reversed: 0` with no explanation (`BulkClient.tsx:220`). Surface the window in the UI and disable the button once it has passed.

## Part 6 — the two-grammar problem

`docs/AX-IE-0-1-PLAN.md:16` claims AX-IE.2 made one schema drive validation on "both server and browser." **`apps/web` imports `@nexus/shared/ads-bulksheet` nowhere** — zero hits across `apps/web/src`.

The old console still carries its own `validateRow` (`BulkOpsClient.tsx:93`), its own `ENTITIES`/`OPS` arrays (`:24-25`), its own comma-only CSV split (`:41-48`) and its own 2000-row cap (`:155`). The new page (`bulk/BulkClient.tsx:17-36`) does no client-side validation at all. So a row can still pass in the browser and be rejected by the server — exactly the problem the shared schema was built to end.

Pick one and do it properly: wire the shared schema into the browser, or delete the legacy console. Do not leave both.

## Part 7 — tests

**Every write path in this layer is untested.** `apply.ts` (212 lines), `preview.ts` (371), `build-workbook.ts` (302), `spreadsheet-adapter.ts` (390), `annotate.ts` (220) — no tests at all. The single existing test (`import-validate.vitest.test.ts`, 116 lines) covers only the magic-byte sniff, the zip-bomb walk, column-letter maths and two constants; **neither `validateBulksheet` nor `validateBulksheetStreaming` runs end to end**, and no fixture workbook exists under `services/advertising/__fixtures__/`.

Build:

1. **A fixture workbook**, plus a second copy round-tripped through **Apple Numbers** — Numbers writes structurally different XLSX (different `dimension` refs, sometimes missing `r` attributes on rows and cells), and the parser must not assume Excel-generated XML.
2. **An end-to-end test**: export → edit → import → preview → apply → rollback, asserting state at each step.
3. **Three invariant tests**, each of which makes a whole bug class unrepeatable:
   - No field may appear in a preview `*_FIELDS` list without a corresponding apply mapping. *(Kills defect 1.)*
   - Every entity the exporter emits must either be applied, **or** be declared `applySupported: false` *and* reach `UNSUPPORTED` in preview — with no third state. *(Kills the Part 2a contradiction and makes export-only rows impossible to ship silently.)*
   - The entity set in `ENTITY_RULES` equals the entity set the exporter can emit, so adding a row type without a grammar entry fails CI.

## How to proceed

1. Read the two vault documents and `docs/AX-IE-0-1-PLAN.md` and `docs/AMAZON-BULKSHEET-SCHEMA.md`.
2. **Do not start coding.** Write a plan for **Part 1 and Part 2 only**. For each item: root cause, every affected call site, the fix, the test that would have caught it, and blast radius.
3. Flag anything here that disagrees with the code. This was written from a read-only review; the source is authoritative.
4. Tell me if you would reorder Parts 4–7, and why.
5. Wait for approval before implementing.

One standing instruction: this codebase's comments are unusually honest — several files state plainly what they do not do (`build-workbook.ts:15-20` on the missing SB/SD sheets, `advertising.routes.ts:4527-4528` on the deferred BullMQ move). Keep that habit. When you defer something, say so in the code, not only in a doc.

# Session 2 handoff — unified imports and source ownership

Date: 2026-09-06. **Status: implementation within Session 2 ownership is ready for coordinator review. Integration clearance is pending the three exact patches below and the native browser upload check. This is not release or Session 4 clearance.**

Browser ownership: **released at 2026-09-06 13:49 UTC**. Session 2 acquired the browser after Session 3 released it, tested on Web 3102/API 4102 with `.next-session-two-test`, restored dark theme and the default viewport, and closed only its own fixture tab. Both Session 2 servers were stopped. Existing servers were not restarted.

Starting files were saved in `/tmp/nexus-session-two-before`; initial working-tree status is `/tmp/nexus-session-two-start-status.txt`. Thirteen existing files were changed and fifteen implementation/test files added. Exact paths and final hashes are in [owned-files.json](session-02-evidence/owned-files.json). No reset, stash, clean, checkout, migration, live catalog fixture, publication or blanket commit was used. The earlier asynchronous lease question was resolved by Session 3's recorded browser release.

## Implemented behavior

- `/products/catalog-transfer` supports ordinary wide CSV, single-sheet XLSX, JSON records and a frozen URL fetch through **source → mapping → complete review → apply**. Existing editable long-format files use the same new job engine. One source can update shared products/variants and multiple explicit account/market/listing destinations.
- Incoming mappings reuse the canonical shared field dictionary, channel catalogue, shape/value validation and channel value mutation semantics. They do not create outgoing mapping rules or duplicate effective shared values in listings. Saved mappings carry declared ownership policies; loading one creates an explicitly disclosed independent review copy.
- SKU identity, including leading zeros, stays stable. Blank SET cells and omitted columns preserve values. Literal text `CLEAR` remains text; explicit CLEAR and INHERIT are distinct actions requiring blank value cells. Conflicting duplicates invalidate the review. Classification ownership is applied before schema selection.
- Shared policies are replace/fill-empty/exclude; scoped policies are replace/preserve/exclude. Shared updates preserve listing overrides. Review counts affected shared/listing records, attribute changes, new overrides, preserved override **entries**, exclusions and failures. Untouched stored entries outside the current field catalogue are included. No sample is labeled as a total.
- All record outcomes persist and are available in server pages of 50, with all attribute/preserved-entry details paginated locally by 25. CSV errors stream all pages. Incomplete previews label their counters as accumulating.
- Stock, pricing and publication remain under their existing owners, including nested Amazon offer/list-price/availability fields and native listing price/quantity storage. ImportWizard's direct legacy writes and unversioned rollback were removed. Historical unversioned jobs require a new reviewed correction; history remains readable.
- URL schedules require an explicit mapping and policy. Reviewed execution is the default; automatic execution must be selected. Concurrent dispatches use a schedule CAS claim, and the durable receipt is linked in the job-creation transaction. Recovery reuses that occurrence's job; changed source policy invalidates automatic apply.
- `/bulk-operations/imports` redirects to the unified Sources & history tab. Its old unused client files were preserved. Catalog-transfer has no secondary navigation.

## Persistence and reusable contracts

No schema or shared-package changes are needed. Existing `ImportJob`/`ImportJobRow` store source shards, indexed record plans and history. A `BulkOperation` with the same ID stores the lease, checkpoint and review summary. New kinds are `catalog-transfer-v2` and `catalog-source-input-v1`. Existing v1 transfer jobs retain their compatibility path.

Source definitions reuse `ScheduledImport` with `targetEntity=catalog-source-v1`: disabled `source=upload` definitions are reusable mappings; `source=url` definitions are schedules. Preset/schedule edits use timestamp CAS. A preset-bound job checks mapping-plus-URL fingerprints, so its own routine scheduling timestamp changes do not invalidate it.

Reviews bind an input hash, 24-hour expiry, explicit coordinates, independent Product/ChannelListing versions and snapshots, dependent shared/parent data, canonical contract hashes and immutable patches. Apply requires the completed review token and owner. Account activity, aliases, snapshots, version and updatedAt are rechecked. A target write, audit, outcome and checkpoint commit in one serializable transaction. Expected refusals become individual outcomes; transient failures leave the checkpoint recoverable. Retry creates a fresh review of only failed/unprocessed records.

STAGING jobs cannot run. Complete staging can recover into preview; incomplete staging fails with a complete-source re-upload instruction and cannot retry a partial file. Recovery stops after five attempts and updates job/history failure state. Parents precede variants even when source order is reversed across preview pages.

## Files and ownership

Existing API files changed, under `apps/api`:

- `src/routes/{catalog-transfer,import-wizard,scheduled-imports}.routes.ts`
- `src/services/{import-wizard,scheduled-import}.service.ts`
- `src/jobs/scheduled-import.job.ts`
- `src/services/pim/catalog-transfer{.service,-plan,-file,-export}.ts`

New API files, under `src/services/pim`:

- `catalog-source-{mapping,file,fetch}.ts`, `catalog-source.service.ts`
- `catalog-transfer-jobs.ts`, `catalog-transfer-preserved.ts`
- `catalog-source-mapping.vitest.test.ts`, `catalog-transfer-jobs.vitest.test.ts`, `catalog-transfer-http.vitest.test.ts`, `catalog-transfer-test/store.ts`

Web changes are confined to `src/app/products/catalog-transfer/{page.tsx,transfer.module.css,SourceMappingEditor.tsx,SourcesPanel.tsx,TransferReview.tsx,sourceMapping.ts,transferApi.ts}` and `src/app/bulk-operations/imports/page.tsx`. Existing preview rendering/tests were preserved and rerun.

No shared DS, Factory, schema, lockfile, API registration, permission manifest, core Studio file, writer/resolver, Session 3 feature, or another session's handoff was edited. Existing DS controls were sufficient; no gap or mirror change was needed. Coordinator-file SHA checks confirm unchanged patch baselines.

## Required coordinator integration

All three patches pass `git apply --check` against the current uncommitted source. **They are not applied.** Baseline hashes are in [baseline-sha256.json](session-02-integration/baseline-sha256.json).

1. [channel-sheet.patch](session-02-integration/channel-sheet.patch): use the existing shared table-export function with SKU/account/market/alias context and review-only labeling; route all channel-sheet Import actions to catalog-transfer. Resolved table values must not claim editable round-trip semantics. The grid engine and preferences remain untouched.
2. [studio-import-route.patch](session-02-integration/studio-import-route.patch): refuse account-less channel imports from both requested scope **and parsed header coordinates**. Scope-only checking is insufficient: the old importer derives per-column scopes from headers. Also refuse apply/revert of historical channel jobs lacking account identity. Master-only Studio imports remain available.
3. [import-permission.patch](session-02-integration/import-permission.patch): change legacy `/api/import-jobs` writes from `products.bulk.run` to `products.import`. The owned legacy route already checks import permission in enforce mode; until integration, the global guard also requires the old bulk permission. Canonical catalog-transfer/scheduled-import prefixes are already registered and covered by `products.import`; export retains `products.export`.

After applying, rerun API/web types and focused Studio import/export, account/write and permission tests. Verify the channel-sheet Import action reaches the unified page, and a legacy keyed channel table gets 409 even when submitted with master scope. These coordinator-owned consumer checks are not claimed as passing.

## Actual verification

| Check | Result |
| --- | --- |
| Focused API transfer/source/canonical mutation/write/resolver suite | **99 passed**, 9 files; 1 intentionally skipped opt-in browser server fixture |
| Web catalog-transfer preview tests | **9 passed**, 1 file |
| API/web typecheck | Passed, exit 0 |
| Web/Factory generated-token checks | Passed |
| `node scripts/ds-conformance-guard.mjs --check` | Passed against existing ratchet |
| Owned tracked-file `git diff --check` | Passed |
| Three coordinator patches `git apply --check` | Passed; unapplied |

Logs are retained in [session-02-evidence](session-02-evidence/). Focused API command:

```sh
npm run test --workspace=@nexus/api -- src/services/pim/catalog-transfer src/services/pim/catalog-source-mapping.vitest.test.ts src/services/pim/channel-value-mutation.vitest.test.ts src/services/pim/channel-value-write.vitest.test.ts src/services/pim/resolve-channel-field.vitest.test.ts
```

Coverage includes mixed accounts/markets; CSV/XLSX equivalence; leading zeros; blanks/omissions; clears/resets; JSON; duplicate conflicts; ownership policies; inactive accounts; managed price/stock fields; actor/input/token/preset conflicts; partial failures/retries; dependency changes; interrupted apply/staging; concurrent scheduled claims; reviewed/automatic URL schedules; complete last-page outcomes; and reversed parent/variant ordering. The HTTP test exercises actual registered multipart upload, preview, outcomes and apply routes, including another actor and stale-token refusals.

The canonical resolver test reflects the new shared title on the other account while its stored listing title/version stay unchanged. Existing canonical SQL write tests use disposable PGlite PostgreSQL. New job/store tests use a transactional Prisma-shaped in-memory fixture; **this is not a production Prisma/PostgreSQL end-to-end concurrency test**.

## Scale measurements and bounds

Final measurements: [preview-metrics.json](session-02-evidence/preview-metrics.json), [file-metrics.json](session-02-evidence/file-metrics.json).

| Fixture | Observed result |
| --- | --- |
| 2,500 products/variants, 5,000 listings, 2,500 shared changes | Preview 2,412 ms; 50 Product reads including staging identity reads; maximum 107 Products per read including parents; all 2,500 outcomes and 5,000 preserved entries counted |
| CSV: 2,500 wide rows, 4,500 actions, 500 blank exclusions | 75,019 bytes; parse/map 8 ms; heap delta +14 MiB; observed process RSS 306 MiB |
| Equivalent XLSX | 61,274 bytes; parse/map 39 ms; heap delta −53 MiB due to GC; observed process RSS 302 MiB |

Preview heap delta was +74 MiB. These process snapshots are **not peak-memory guarantees**. Instrumentation verifies query shape/returned rows, not network/database latency. The reversed-order apply test covers 130 records; a full 2,500-record apply against deployed schema/indexes remains a Session 5 scale gate.

Input bounds: 10 MB, 50,000 rows, 200 columns, 50,000 mapped action/issue/exclusion outcomes. XLSX expanded content is checked against 40 MB/2,000 archive entries before ExcelJS document parsing; formulas/errors are refused. Source shards and target batches use 100 records. Reference queries restrict families/categories/accounts/markets to requested data. Listing/preserved-entry enumeration has explicit refusal bounds. The bounded source table remains in memory during mapping; this is not unlimited streaming.

## Browser evidence and remaining limits

Chrome opened the chooser but refused to attach the CSV (`Not allowed`): its **Allow access to file URLs** extension setting was off. Multipart HTTP upload passed; the native browser upload step is **not verified**. Enable that setting and repeat the chooser with `/tmp/nexus-session-two-browser-source.csv` before browser clearance.

The browser then consumed that CSV through `https://supplier.example/session-two.csv`, intercepted only by the isolated fixture's fetch module. No supplier was contacted. Source loading → mixed mapping → save mapping → full review → apply → completed history passed against a fixture containing 2,500 products/5,000 listings. Two shared updates and one account-a/IT override produced exactly three audit entries. Four material overrides, stock 17/price 25 on both products, and account-b/FR records stayed unchanged: [browser-records.json](session-02-evidence/browser-records.json).

Keyboard family selection and Enter activation of Apply passed. Dark/light desktop and 390×844 layouts were inspected; document width and scroll width both equaled 390, and detail tables scroll internally. Screenshots: [dark desktop](session-02-evidence/review-dark-desktop.png), [dark narrow](session-02-evidence/review-dark-narrow.png), [light narrow](session-02-evidence/review-light-narrow.png), [light sources/history](session-02-evidence/sources-light-desktop.png). No console errors/warnings were captured. The existing fixed Ask AI control overlaps part of the bottom action area on narrow screens; Apply remains keyboard accessible. This shared-shell overlap was not changed.

Other limits:

- URL fetches allow public HTTP(S), without embedded credentials, custom ports, redirects or FTP. DNS is checked/pinned and response time/bytes bounded. Workflow transport was isolated/mocked; no live supplier fetch was exercised.
- Schedules show last dispatch status; their linked import/history exposes current processing results. The UI saves mapping copies; the API also supports versioned updates. Schedule listing is capped at 100 in the panel; preset/history/outcome review is paginated.
- When shared categories change and a scoped import depends on their inherited listing category, declare the listing category explicitly or review the scoped import after the shared update. Preview refuses the ambiguous future dictionary.
- Token expiry is enforced; retention/garbage collection of source shards/history is not added.
- Production database scale, deployed permission integration, marketplace publication and live-catalog mutation were not performed. No unrelated guard failure occurred in the checks run.

To rerun the isolated UI fixture, use `NEXUS_SESSION_TWO_BROWSER=1` with the HTTP test and `-t 'serves the isolated browser fixture'`. Start a separate Next server with `NEXT_DIST_DIR=.next-session-two-test`, `NEXT_DEV_STUB_PROXY=http://127.0.0.1:4102`, `NEXT_PUBLIC_API_URL=http://localhost:3102`, `NEXT_PUBLIC_AUTH_ENFORCE=0`, `--webpack -p 3102`. This uses a synthetic owner and in-memory catalog only. Acquire the browser lease first and stop both fixture processes afterward.


## Product-presets follow-up — started 2026-09-06

Status: implementation started against the current dirty source. The preceding receipt is historical; the coordinator has now applied and verified all three original Session 02 integration patches. They will not be reapplied.

Baseline copies: `/tmp/nexus-session-two-presets-before`; status: `/tmp/nexus-session-two-presets-start-status.txt`. Owned existing areas are the listing-preset library/picker, product list-wizard draft/preset behavior, `routes/wizard-templates.routes.ts`, draft/read portions of `routes/listing-wizard.routes.ts`, and `services/listing-wizard/preset-defaults.ts` plus focused tests. New files will be under Studio `presets/` and focused listing-wizard preset/draft service modules. Whole-file coordinator and Session 03 boundaries remain in force.

Initial supported contract: apply once fills absent compatible variation defaults in an existing-owner ListingWizard draft for the selected product/family, explicit primary account, market and primary listing. The current channel+market consumer cannot safely address alternate accounts or aliases: these are refused explicitly. Shared SKUs, shared variant creation, product/listing facts, other destinations and reusable definitions are unchanged. Product-context review excludes SKU-generation defaults and other preset destinations; its result is a draft update, not a stored listing assignment or publication. Binding/revision checks and consumer verification are implementation requirements. New Studio mounting is coordinator integration only. Shared baseline hashes are saved; no channel helper/submission/DS/schema patch is assumed until the consumer trace establishes it.

Browser follow-up: Session 02 has the first turn under the current README. Acquisition/release and the chooser result will be recorded below.

**Follow-up browser acquired by Session 02 at 2026-09-06 14:48 UTC** for the isolated native-import recheck. Session 03 has recorded that it is waiting. Ports 3102/4102 were free before starting our fixtures.

**Follow-up browser released at 2026-09-06 14:50 UTC.** Native chooser opened; `setFiles` still returned Chrome `Not allowed`. No extension/security setting was changed. A stale development chunk initially raised a syntax error; normal page reload recovered before testing the chooser. The fixture tab was closed and its two servers stopped. Session 03 may acquire the browser. Preset implementation continues independently. The later preset UI check will wait for Session 03 to release it.

### Product-presets contract ready for coordinator review — 2026-09-06

Exact shared-file patches (not applied by Session 02): `session-02-presets-integration/submission-contract.patch` and `information-mount.patch`; current baseline SHA-256 values are alongside them in `baseline-sha256.json`. Both currently pass `git apply --check`. The mount adds an Information overflow action for the selected row (or the page product's primary row) and a modal feature surface; it adds no standing toolbar width or grid-engine changes.

The supported operation fills a missing, schema-compatible variation theme for one product, explicit primary account, market and primary listing. A classified exact listing can initialize a new single-destination ListingWizard; otherwise an existing classified single-destination draft is required. Existing draft choices and stored listing themes are preserved. Other preset destinations, SKU generation, custom axes and product facts are excluded visibly. No shared SKU/variant/listing writer is used.

`state.productPresetScope` freezes `{productId, channel, accountId, market, listingId, aliasKey:''}`. Product application uses the existing `/wizard-templates/:id/apply` with `productContext`; dry-run returns `reviewKey`, target and definition snapshots. Apply recomputes the review fingerprint inside a Serializable transaction, CASes the draft and preset definition, writes the actual consumer's `channelStates[key].variations.theme` plus the step's `state.variations.themeByChannel[key]`, and records an idempotent receipt. No alternate tuple hash, resolver, preset store, schema or registration is introduced. Usage increments once without changing the reusable definition's timestamp.

The shared submission patch is required before mounting: every composer call for a `productPresetScope` draft must return unsupported, including scheduled callers. The existing dispatcher honors that result. It also preserves explicit null/blank/false in the consumer instead of falling through to a common theme. New product-bound API mutation guards and Step 9 already refuse publication in owned files. This is draft application, not completed account-aware listing publication; Session 03 must not treat these drafts as an agreed publication destination contract. Its reviewed presentation/order consumers remain separate.

Exact scoped resume links now carry wizard ID, product, channel, account, market, listing ID and alias. Legacy start/resume cannot strip account/alias inputs or reopen a bound draft as primary implicitly. Selection, preview and apply responses are invalidated when the feature's scope changes. Verification is continuing; this contract receipt is not integration clearance.

Contract refinement after tracing built-in definitions: for an explicitly **unlisted Amazon destination**, the same reviewed operation now also fills absent `skuStrategy.parentSku` / `childSku` settings in the wizard draft. These are the future listing SKU settings that the real composer consumes; they never write Product.sku or existing listing identities. Existing listings exclude these settings. eBay SKU settings and `fbaFbm` suffix defaults are excluded because their effective consumers do not use them. This supersedes the initial blanket SKU exclusion above. A SKU-only draft can be created before category selection; a new variation theme still requires classification and the existing variation schema. Shared SKU/variant creation and publication remain outside this operation. All earlier account/listing/revision boundaries remain unchanged.

**Preset browser acquired by Session 02 at 2026-09-06 16:10 UTC**, after the latest Session 03 pass explicitly released browser ownership. The fixture uses only 3102/4102 and `.next-session-two-test`; Session 03's 3103/4103 processes and other tabs are untouched. Testing the real preset feature in its temporary isolated route, then the owned wizard resume path; this does not claim the coordinator's Information mount is integrated.

**Preset browser released by Session 02 at 2026-09-06 16:27 UTC.** The owned tab was closed and the viewport reset. Only Session 02's API PID 51966 and Web PID 47759 were stopped; the API fixture removes its temporary page on shutdown. Keyboard selection/review/cancel/apply, narrow light/dark review, existing/new draft resume, explicit variant preservation and alternate-account refusal were observed. Final evidence and integration receipt follow below; the coordinator may use the browser.

## Product-presets follow-up receipt — 2026-09-06

**Readiness: the bounded product-preset implementation is ready for coordinator integration review. It is not mounted in Information and is not integrated/product-phase or publication clearance.** The two new shared-file patches below remain unapplied. The original import integration is preserved. Native chooser verification still lacks the Chrome file-access prerequisite; the unrelated Factory guard failures remain.

### Changed files and preserved ownership

The exact starting-source diff and hashes are in [owned-baseline.diff](session-02-presets-evidence/owned-baseline.diff) and [owned-changes.json](session-02-presets-evidence/owned-changes.json): nine existing source files changed and eleven focused source/test files added. Starting copies remain at `/tmp/nexus-session-two-presets-before`.

- API: `routes/{wizard-templates.routes.ts,listing-wizard.routes.ts}`; new `services/listing-wizard/product-presets.ts`, `product-presets-test-store.ts`, `product-presets.vitest.test.ts`, `product-presets-submission-patch.vitest.test.ts`, and `routes/product-presets-http.vitest.test.ts`.
- Web library: `channels/listing-presets/ListingPresetsClient.tsx`, extending the canonical picker with contextual wording.
- New Studio feature: `products/[id]/edit/_studio/presets/{ProductListingPresets.tsx,BoundPresetDestination.tsx,product-preset-contract.ts,product-preset-contract.vitest.test.ts}`.
- Owned wizard: `page.tsx`, `ListWizardClient.tsx`, `components/WizardHeader.tsx`, `steps/{Step1Channels.tsx,Step5Variations.tsx,Step9Submit.tsx}` and new `steps/{variation-selection.ts,variation-selection.vitest.test.ts}`.

No shared DS/Factory implementation, grid engine, schema, migration, registration, permissions, lockfile, core writer/resolver, Studio shell, or Session 03 consumer was edited. Existing Nexus Drawer, Button, Banner, KeyValue, ProgressBar and library controls covered the new surface; no DS gap or mirror change was needed. The existing wizard's unrelated steps and legacy visual styles were not migrated. No owned baseline file is missing. The three shared wizard service baselines are byte-identical; StudioTabHost and ChannelSheet changed under their other owner and were not restored: [shared-baseline-audit.json](session-02-presets-evidence/shared-baseline-audit.json).

### Final supported operation and persistence

The product action shows product/family, channel, explicit account, market and primary listing or explicit absence. It reviews compatible defaults and visible exclusions, then **applies once to a ListingWizard draft**. Shared management is explicitly labeled **Manage shared presets (all products)**. It creates no standing rule and does not update/publish a stored listing.

Only the canonical primary connected account is supported by the existing channel+market wizard. Alternate accounts and aliases are refused, never normalized into primary. Named existing listings must match product/account/channel/market/primary identity and remain active/published; unlisted means the exact primary listing is absent. A draft must be active, unexpired, for the same product and exactly one canonical destination. A differently bound or multi-destination draft is refused.

Supported defaults are a missing schema-compatible variation theme, and—only for an unlisted Amazon destination—missing `skuStrategy.parentSku` / `childSku` future listing settings. The latter do not rewrite Product.sku or existing listing identities. Existing explicit choices, including blank/null/false and empty variant selections, remain owned. Stored listing themes are preserved. Other destinations, selected variants, product facts, prices, stock, custom axes, existing listing SKU strategy, eBay SKU settings and unused fulfilment suffix settings are excluded. A new theme requires classification from the draft or exact listing plus the actual variation schema. A SKU-only draft can start before category selection.

`POST /api/wizard-templates/:id/apply` retains its original owner and adds `productContext`. `dryRun:true` returns the review fingerprint; apply requires that fingerprint and optional reviewed wizard ID. The fingerprint includes the explicit scope, product/account/listing snapshot, preset definition/revision, wizard revision and relevant schema/projection. Apply recomputes inside a Serializable transaction, CASes the wizard and definition, then records the frozen `state.productPresetScope` and idempotent `productPresetReceipt`. Retry does not increment usage or write the draft again. Preset definition fields/timestamp remain unchanged; only usage count/last-used metadata changes.

Variation defaults persist into both `state.variations.themeByChannel[key]` and the real consumer's `channelStates[key].variations.theme`. Selection saves update the parent wizard state/ref and consumer slices together, so later navigation cannot restore an old selection. Untouched rendering does not autosave or select all variants. Preview/apply requests have abort and generation guards across full scope changes. Resume URLs retain wizard/product/channel/account/market/listing/alias; legacy start/resume cannot silently strip them. Back and Save/Close return to the exact Studio scope. Later bound-draft PATCHes require the current `expectedUpdatedAt`, in addition to the existing database CAS. Expired/non-draft resumes are refused. Bound drafts permit reads, revision-checked draft edits and telemetry; publication, scheduling and other listing operations remain guarded.

### Exact coordinator integration

Apply [submission-contract.patch](session-02-presets-integration/submission-contract.patch) before exposing [information-mount.patch](session-02-presets-integration/information-mount.patch). Both pass `git apply --check`: [integration-checks.json](session-02-presets-evidence/integration-checks.json). [baseline-sha256.json](session-02-presets-integration/baseline-sha256.json) identifies the current source; the mount patch was refreshed against the coordinator's newer ChannelSheet without changing that file.

1. **Submission contract:** all composer calls for a draft containing `productPresetScope`, including scheduled callers, return unsupported before destination resolution or publication. The existing dispatcher honors this. Theme precedence respects an explicit consumer theme, then an explicit per-channel selection, then common theme; explicit null/blank/false never fall through. This is a publication guard, not an account-aware publishing implementation. Session 03's separate presentation/order publishing contract is untouched.
2. **Information mount:** an existing toolbar overflow item targets the selected single row, otherwise the page product's primary row. It names the SKU and passes the exact row/product/account/market/listing/alias into the feature. Its controlled drawer adds no standing toolbar width and changes no grid behavior. Scope changes close it. A pending consumer patch is not described as already mounted.

After integration, rerun the combined wizard/Studio/consumer checks, then exercise this actual overflow mount, product/account/market/row switches, preset review/apply and return navigation with the full isolated Studio API. Keep publishing guarded until the later listing lifecycle owner implements and verifies the account/listing destination contract.

### Fresh verification

| Check | Actual result |
| --- | --- |
| API presets/defaults/registered routes/existing wizard PATCH and library suite | **53 passed**, 6 files; 1 intentionally skipped opt-in browser fixture |
| Web preset contract/variation selection/import preview suite | **25 passed**, 3 files |
| API workspace types and exact submission patch virtual-source typecheck | Passed |
| Web workspace types and exact mount patch virtual-source typecheck | Passed against the final coordinator source |
| Web and Factory generated-token checks | Passed |
| Web DS token guard, conformance and raw-control ratchets | Passed; 165 DS files, 4,368 raw controls / 4,692 baseline; no file rose |
| Factory DS token guard | Existing unrelated **320 violations in 105 files**, primarily platform aliases; no Factory file edited |
| Owned tracked diff / new source trailing whitespace | Passed |
| Two coordinator patches | Apply-check passed; unapplied |

Logs are in [session-02-presets-evidence](session-02-presets-evidence/), including `final-{api,web}-tests.log`, `final-{api,web}-types.log`, `final-{api,web}-patch-types.log`, generated-token logs and guard logs. An intermediate Web check reported unused `channelLabel` and `options` declarations in coordinator-owned ChannelSheet. The coordinator's later source cleared those errors; Session 02 did not edit the shared file. The mount patch/hash and typecheck were refreshed against that final source.

```sh
npm run test --workspace=@nexus/api -- src/services/listing-wizard/product-presets src/services/listing-wizard/preset-defaults.vitest.test.ts src/routes/product-presets-http.vitest.test.ts src/routes/wizard-templates.vitest.test.ts src/routes/listing-wizard-patch.vitest.test.ts
npm run test --workspace=@nexus/web -- 'src/app/products/[id]/edit/_studio/presets' 'src/app/products/[id]/list-wizard' src/app/channels/listing-presets src/app/products/catalog-transfer
```

Tests cover two families, two accounts in one market, another market and aliases; compatible/incompatible presets; explicit empty/blank/null/false preservation; stale product/account/listing/preset/draft/schema targets; changed account; absence becoming a listing; retry/resume; expired/non-draft and wrong-product refusal; CAS rollback; frozen metadata/destinations; and no product/listing writes. The actual canonical account resolver and VariationsService are exercised with synthetic persistence/schema transport. The actual submission validator consumes the saved theme/selection. A test copies the current coordinator submission source into a temporary directory, applies the exact patch, executes its early refusal and theme precedence, and exercises its real SKU strategy helpers; it never patches the shared working source. These are isolated transactional in-memory tests, not deployed PostgreSQL concurrency or live marketplace tests. The late mandatory revision/expiry guards were HTTP-tested after browser release.

### Browser observations and limits

The preset lease ran **16:10–16:27 UTC**, only on Session 02's 3102/4102 environment. The real feature was mounted in a temporary owned fixture route, removed on shutdown; both owned processes stopped and viewport/tab ownership was released. No live catalog or marketplace was used.

- Keyboard Enter opened the picker, reviewed a preset and applied it. Escape closed the drawer and restored focus to Listing presets. Tab from the final action stayed inside the dialog. Cancel made **zero writes**.
- Alpine/account-a/IT/primary reviewed SIZE_NAME from absent, visibly excluded FR, selected variants, pricing and existing listing SKU strategy, then saved the existing draft. Resume retained every destination coordinate and showed SIZE_NAME with the original empty `includedSkus:[]`. Explicit Space selection of p1-S saved it; reload retained it and the real validator reported `1 included (theme: SIZE_NAME)`.
- Back saved and reached `/products/p1/edit?scope=AMAZON&account=account-a&market=IT&listing=p1%3Aaccount-a%3AIT%3Aprimary`. Full Studio rendering is outside the fixture's API model: its fallback response caused `arr is not iterable` in ProductEditClient. This proves the return URL, not integrated Studio rendering.
- Coastal/account-a/FR/unlisted reviewed and saved a **new** draft with only future parent/variant SKU settings. The unused fulfilment suffix was excluded visibly. Resume kept `listingId=&aliasKey=` and showed the frozen primary destination.
- Selecting account-b produced the explicit primary-account-only refusal and no writes. After all actions, both products/families, both accounts, all **15 listing records**, prices 25, stock 17, other markets/aliases and reusable definitions were byte-equivalent to before. Only the two intended drafts and usage metadata changed: [browser-records.json](session-02-presets-evidence/browser-records.json).
- New review/receipt presentation was inspected at desktop and **390×844 in light/dark**. At narrow size, document width/scrollWidth and drawer width were all 390; drawer height was 844. Content scrolls vertically and footer actions remain visible. Evidence: [light desktop](session-02-presets-evidence/review-light-desktop.png), [dark desktop](session-02-presets-evidence/review-dark-desktop.png), [light narrow](session-02-presets-evidence/review-light-narrow.png), [dark narrow](session-02-presets-evidence/review-dark-narrow.png), [saved receipt](session-02-presets-evidence/applied-light-narrow.png), [SKU review](session-02-presets-evidence/future-skus-review.png), and [resumed selection](session-02-presets-evidence/resume-persisted-selection.png).

The run is **not console-clean or a full wizard visual clearance**. Development logs include a recovered layout chunk failure, a not-yet-mounted React update warning, AppNavRail key and smooth-scroll warnings, and the unsupported full-Studio fixture error above. The legacy wizard resume page also shows inconsistent dark canvas/control contrast; the new DS preset drawer itself was checked in both themes. The log is retained as `browser-web.log`; these issues were not hidden by changing shared files. The owned status text was corrected to recognize per-channel themes and refresh blocker reasons; the wizard header now preserves the destination.

Native import was revisited earlier at **14:48–14:50 UTC**: the chooser opened, but Chrome `setFiles` again returned **Not allowed** with the extension's **Allow access to file URLs** setting off. No security permission was changed. Native chooser completion remains unverified; existing HTTP multipart and URL-input evidence remains distinct. Enable that prerequisite explicitly, then repeat the isolated chooser before import browser clearance.

To repeat the preset fixture, set `NEXUS_SESSION_TWO_PRESETS_BROWSER=1` and run the HTTP test with `-t 'serves isolated preset browser fixture'`. Its temporary route uses exclusive creation and removes only its own file on shutdown. Use the existing isolated Next recipe with `.next-session-two-test`, proxy 4102 and Web port 3102, after checking availability and acquiring the shared browser lease. Full build, integrated Studio/browser/permissions, database concurrency/scale and account-aware publication remain coordinator/later-session gates.

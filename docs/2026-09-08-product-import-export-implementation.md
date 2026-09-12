# Product editor import and export: implementation and verification

2026-09-08. Implemented in the working tree. No deployment or working-catalog writes were performed. This report supersedes the implementation status in the [earlier assessment](2026-09-08-product-import-export-approach.md).

The product editor now uses the existing catalog planner, validation, resolvers and transactional writer for editing workbooks, complete Nexus ZIP exports and mapped supplier files. It retains one product identity while treating every primary or named listing alias as an independent destination.

The subsequent [workbook functionality pass](audits/2026-09-08-workbook-functionality/README.md) adds horizontal choices with strict/suggested rules, protected references, compact rows, visible export expiry and native spreadsheet compatibility. Its final checks passed: 56 focused tests, API types and a LibreOffice save/re-import preserving all 335 real-product attribute values. `TRUE()` and `FALSE()` in value cells are read as boolean constants without evaluating formulas or trusting cached results; calculated formulas remain refused.

## What changed

- **Scope:** choose current/selected/specific SKUs and the current listing, all aliases in its account and market, all destinations or specific destinations. Friendly alias names appear in selection, workbooks and review. Shared details and content languages are independent choices. Matching still uses immutable identities and exact account/market/alias coordinates.
- **Editing workbook v3:** ordinary nonblank edits become SET; unchanged or blank cells preserve the exported value and ownership. Hidden advanced action columns support explicit SET, CLEAR and INHERIT. A server-held, owner-bound baseline expires after 30 days. Missing versions, changed identities, malformed metadata and missing/expired baselines require correction. They do not silently fall back to unprotected import.
- **Export:** select visible editable fields or all editable fields, with required identity/classification information retained. Stable field keys remain in headers; readable labels and instructions appear in the workbook. Named aliases have visible labels and hidden identity metadata. Managed fields are omitted from the normal editing area.
- **Import:** recognize Nexus files and restore their authorized scope; inspect once, then preview using the staged input. Complete ZIP batches are validated together, including missing/extra parts and duplicate targets. Supplier files use the existing mapping controls inside the product editor, with named destinations and their actual field dictionaries. Product-editor imports only update existing permitted records.
- **Review:** lead with changes or issues, show friendly destinations, source file/sheet/row/column, and resolve effective before/after values using the same master/channel rules as the grid. Resolution failures are explicit warnings. Filters change the review view; saving still applies the complete reviewed file. Historical reviews label their values as snapshots rather than current catalog truth.
- **Save and recovery:** final receipts distinguish saved, unchanged, refused, excluded and unprocessed records. Double apply cannot replay committed writes. Recent owner/product imports can be reopened after navigation or a lost response. Retry reviews include only remaining records. Legacy jobs remain readable without fabricated detailed receipts.
- **Formula protection:** unchanged formula-controlled cells remain unchanged. Changes to known formula-controlled cells and declared formula dependencies are refused with guidance to edit in the grid, where recalculation is supported. This implementation does not import or replace formulas.

The main entry point is [ProductTransferDrawer](../apps/web/src/app/products/[id]/edit/_studio/import/ProductTransferDrawer.tsx). The key server additions are [editor workbook handling](../apps/api/src/services/pim/catalog-editor-workbook.ts), [effective-value review](../apps/api/src/services/pim/catalog-transfer-effects.ts), and [durable job outcomes](../apps/api/src/services/pim/catalog-transfer-jobs.ts).

UI changes compose the Nexus design system. The only feature CSS addition arranges receipt metrics responsively. No shared design-system source changes were needed, so there is no corresponding Factory component patch.

## Verified behavior

The focused API suite passed **151 tests**, with **3 optional tests skipped**. The final job/recovery follow-up passed **42 tests**, with **2 optional tests skipped**, including two additional cases for exhausted recovery and legacy receipts. The web suite passed **25 tests**. API and web type checks, the shared package build, and web/Factory token checks passed.

Coverage includes primary plus multiple named aliases; untouched account/listing isolation; exact destination authorization; owner/product/expiry baseline checks; missing versions; typed and inherited round trips; formula refusal; full ZIP validation; multipart inspect followed by JSON preview; supplier mapping and apply; stale/concurrent edits; transactional recovery; duplicate apply; and receipt accounting. Tests use an isolated Prisma-shaped store, not a production database.

The real drawer, mapping editor, review and design-system components were also exercised through the [isolated browser fixture](audits/2026-09-08-product-transfer/browser-fixture/README.md):

- Selected several named aliases and started an editing-workbook download.
- Mapped supplier title columns to Summer and Outlet independently and reviewed resolved values and source locations.
- Filtered to one alias, saved the complete reviewed two-listing file, and verified the two-write receipt. Primary and the other account remained unchanged; exactly two audit records were written.
- Reopened the saved job through Recent imports after losing the client-side job reference.
- Checked a 390px dark receipt and light export drawer. The drawer had no horizontal overflow. Checked focus wrapping, Escape and focus restoration; confirmed the save callback requested product refresh.

Evidence: [API tests](audits/2026-09-08-product-transfer/api-tests.log), [final recovery tests](audits/2026-09-08-product-transfer/recovery-tests.log), [web tests](audits/2026-09-08-product-transfer/web-tests.log), [API types](audits/2026-09-08-product-transfer/api-types.log), [web types](audits/2026-09-08-product-transfer/web-types.log), [web tokens](audits/2026-09-08-product-transfer/web-tokens.log), [Factory tokens](audits/2026-09-08-product-transfer/factory-tokens.log), [synthetic saved-store evidence](audits/2026-09-08-product-transfer/browser-store-evidence.json), [dark receipt](audits/2026-09-08-product-transfer/dark-receipt-390.png), [light export](audits/2026-09-08-product-transfer/light-export-390.png).

## Performance and bounds

Removed repeated full-boundary scans during per-record authorization, cached filtered export field lists, reused inspected input, and paged outcomes and recent-job lookup. The canonical transactional rechecks remain in place.

One synthetic run per case used three listings per SKU and sparse/dense fields. Times below are milliseconds. Preview is measured separately from parsing and staging. These are local measurements, not production latency guarantees or p95 results.

| SKUs | Fields | Attribute inputs | Export | Parse | Stage | Preview | Apply |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Sparse | 9 | 27 | 14 | 1 | 51 | 3 |
| 1 | Dense | 159 | 29 | 14 | 1 | 52 | 5 |
| 25 | Sparse | 225 | 13 | 8 | 3 | 54 | 41 |
| 25 | Dense | 3,975 | 42 | 30 | 27 | 104 | 98 |
| 100 | Sparse | 900 | 53 | 14 | 11 | 131 | 342 |
| 100 | Dense | 15,900 | 131 | 81 | 83 | 415 | 591 |
| 500 | Sparse | 4,500 | 176 | 60 | 82 | 1,232 | 8,854 |
| 500 | Dense | 79,500 | 777 | 422 | 431 | 2,716 | 10,052 |

[Raw metrics](audits/2026-09-08-product-transfer/performance.json) include instrumented database-method calls and sampled process RSS. These method counts include nested test-store implementations and are not SQL-query counts. RSS reached 832 MiB in the final sequential case; it includes the synthetic database, retained baselines/jobs and previous cases. It is not isolated operation peak memory. Real PostgreSQL latency and memory measurements are still needed for large-catalog release acceptance.

The editor caps a batch at 250,000 attribute outcomes and 50 parts. ZIP input is bounded to 50 MB compressed and extracted workbook bytes, 10 MB per workbook, 40 MB expanded XLSX content per workbook and 128 MB expanded content per batch. Export reserves archive overhead with a 49 MB workbook-byte budget. Oversized input receives an explicit error. Large export parts are still buffered within these limits; durable artifact jobs and streaming storage remain possible follow-up work if production measurements warrant them.

## Remaining acceptance limits

1. **Normal product-page runtime:** the existing local product page returned HTTP 500 during this session. The isolated fixture verified the actual transfer components and registered API routes, but full-page integration and visible grid refresh require rerunning after that runtime issue is fixed. A concurrent shared-package dependency initially interrupted API type checking; rebuilding the shared package resolved it.
2. **Native file selection:** the browser automation environment refused the file chooser's `setFiles` operation. Multipart upload was verified through the actual HTTP route tests; browser mapping used a clearly labeled synthetic-source fixture action. End-to-end native file selection is not claimed as verified.
3. **Accessibility and performance:** narrow light/dark presentation and basic keyboard behavior were checked. Full screen-reader, zoom, keyboard upload, production database, p95 latency and isolated peak-memory acceptance remain outstanding. “AAA” is a quality goal, not a conformance certification.
4. **Intentional limits:** formula import/replacement is unavailable; declared formula sources must be edited in the grid. Effective preview explains directly reviewed cells and is not a complete inventory of downstream inheriting listings. Export baselines expire after 30 days and staged inspection after 24 hours. Older file formats keep their documented operation semantics with explicit warnings.

## Reproduce the checks

```sh
npm run build --workspace=@nexus/shared
npm run typecheck --workspace=@nexus/api
npm run typecheck --workspace=@nexus/web
npm run test --workspace=@nexus/api -- src/services/pim/catalog-product-transfer.vitest.test.ts src/services/pim/catalog-transfer.vitest.test.ts src/services/pim/catalog-workbook.vitest.test.ts src/services/pim/catalog-transfer-jobs.vitest.test.ts src/services/pim/catalog-transfer-transaction.vitest.test.ts src/services/pim/catalog-transfer-http.vitest.test.ts src/services/pim/catalog-transfer-download.vitest.test.ts src/services/pim/catalog-source-mapping.vitest.test.ts src/services/pim/mapping/resolve-batch.vitest.test.ts
npm run test --workspace=@nexus/web -- productTransferSelection.vitest.test.ts previewColumns.vitest.test.ts workbookSelection.vitest.test.ts
npm run tokens:check
npm run tokens:check:factory
NEXUS_PRODUCT_TRANSFER_BENCH=1 npm run test --workspace=@nexus/api -- src/services/pim/catalog-product-transfer.vitest.test.ts -t 'measures product editing'
```

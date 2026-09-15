# Product sheet autosave diagnosis — 2026-09-15

The reported delay is real: production `/api/products/bulk` PATCH requests took **21,101 ms** and **17,797 ms**. The shared sheet writer waits only **40 ms** before sending a committed edit. Text entry also has an explicit Apply boundary; pausing inside its popup does not start a write.

## Evidence

Read-only Railway HTTP logs for `@nexus/api`, production, retrieved on September 15:

| Request | UTC timestamp | Status | Total / upstream duration |
| --- | --- | --- | --- |
| `lYAxurtJSny2rP7-63j4Ww` | 2026-09-15 14:33:50 | 200 | 21,101 / 21,101 ms |
| `UJpXv5tZQxS_rWhtALIuDA` | 2026-09-15 14:34:08 | 200 | 17,797 / 17,797 ms |

These are two samples, not a percentile. HTTP logs do not expose their product IDs, changed fields, response bodies, or time spent in individual phases. Successful HTTP responses establish slow acknowledgement, not independent persistence read-back.

The same log source returned successful notification and sidebar GET requests in 190–365 ms during inspection. The last-three-hours PATCH query was empty; widening to 24 hours found the two positive controls above. No production edit was made to generate these measurements.

The open signed-in production page was GALE-JACKET, Amazon · IT, Information, with 21 rows. Opening the existing child title without changing it displayed `Cell value`, `Enter to apply`, `Cancel`, and `Apply`, while the header continued to say `Nexus draft autosave`. Cancel restored the view. This confirms the UI contract; no typed production edit or forced save was attempted.

## Graphify trace and files to access

The existing 68,345-node Graphify index located this path; source inspection confirmed it:

1. `apps/web/src/design-system/grid/editors/FormulaCellEditor.tsx:49`: the shared editor also hosts ordinary text and numbers. `change()` reports the draft through AG Grid's `onValueChange`; `save()` ends editing. Enter/Apply or AG's end-edit handling causes the cell change event. There is no idle-save timer here. Preserve Cancel and formula validation when changing this behavior.
2. `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/useChannelSheetAdapter.tsx:225`: the channel adapter creates the shared writer and reports a pending save when a batch starts. Its cell-change handler is the bridge from AG Grid to persistence.
3. `apps/web/src/design-system/grid/editors/sheetWriter.ts:517`: `DEFAULT_SHEET_FLUSH_MS = 40`. `schedule()` and `flushRow()` serialize writes per row, so slow acknowledgements hold subsequent edits to that row. This is required for version ordering; reducing the 40 ms window will not remove seconds of backend work.
4. `apps/web/src/app/products/[id]/edit/_studio/sheet/channel/useChannelSheet.ts:299` and `.../master/masterWrite.ts:122`: PATCH `/api/products/bulk` with a **30,000 ms** client timeout. Missing confirmation enters the existing reconciliation path rather than inventing a refusal.
5. `apps/api/src/services/products/bulk-edit.service.ts:194`: the entire edit runs within `inDatabaseTransaction`. At **2603**, the factual/attribute path calls `produceReadiness(id)` **without its supported destination scope**, even for listing-only edits. This is the clearest unnecessary-work defect. At 2604 it schedules the product read-cache refresh.
6. `apps/api/src/services/pim/readiness-index.service.ts:17`: resolves the product's family root. At **24**, `reconcileFamilyReadiness` builds destinations for active markets/accounts/languages, then **sequentially awaits `getStudioSheet` for each destination** before replacing the readiness rows. Without scope, a single cell can trigger all destinations and the entire family.
7. `apps/api/src/lib/database-context.ts:56`: waits for readiness producers **before transaction commit**, then waits for post-commit effects before returning. Transaction options allow **10 s** acquisition and **60 s** execution, with up to two serialization retries. This exceeds the client's 30 s patience. A refresh can therefore delay acknowledgement even after the value is committed.

Localized content has a separate branch through `content-bulk-write.ts`. Pin writes in `content-write.ts:84` already pass channel/market/account to readiness. Do not assume the unscoped factual-write defect applies to every title edit. Even scoped readiness still rebuilds the family sheet for that destination's languages.

The `elapsedMs` payload at `bulk-edit.service.ts:2498` is captured **before** audit/activity work, readiness production, and the post-commit cache refresh. It understates end-to-end save latency; use HTTP timing for the current baseline.

## Recommended correction and acceptance bar

- Pass the affected channel/market/account to readiness for listing-only factual/attribute changes, using the existing write-routing predicate and resolved account. Shared edits must still invalidate every dependent destination. Preserve atomic readiness, audit history, formula cascades, concurrency checks, and cache consistency.
- Measure schema validation, mutation, readiness, commit, and cache-refresh durations separately on a disposable local fixture. Optimize the measured dominant phase; do not simply detach required work or lengthen the timeout.
- Treat editor draft versus pending save explicitly. An idle autosave change must define Cancel/escape and formula behavior first; blindly auto-applying and closing the editor on a timer would interrupt typing and change cancellation semantics.
- Proposed targets: visible save feedback within 100 ms after commit, warm single-cell acknowledgement p95 under 1 s. These are acceptance targets, not achieved results.
- Verify persistence with an independent read after 8 seconds and compare the relevant product/listing/content version. Exercise rapid same-row edits, multiple rows, shared inheritance, multiple accounts/languages, formula dependencies, conflict, slow response, dropped response, and recovery. If shared UI changes, mirror the design system in factory and verify keyboard and responsive light/dark behavior.

## Initial diagnostic verification

The existing web suites for SheetWriter, timeout handling, FormulaCellEditor, and channel writes passed: **66 tests in 4 files**. API bulk-edit/no-op and database-read suites passed: **77 tests in 2 files**. Total: **143 passing tests**. These verify current contracts; they do not establish an end-to-end performance budget.

Those checks preceded implementation. The exact contribution of each backend phase to the two production requests remains unmeasured.

## Implemented correction

- `bulk-edit.service.ts` now passes the resolved account, channel and market to readiness for listing-only edits. It reuses the actual write-routing predicate. Shared, mixed and multiple-destination edits retain broad invalidation; validation, version checks, audit, formulas and atomic readiness remain in place.
- `workspaceSave.ts`, `useSheetPublicationGuard.ts`, `contracts.tsx`, `PublishMenu.tsx` and `PublishDialog.tsx` drain queued sheet writes before review, then check live editor guards and the synchronous save ledger before review and submission. The ledger includes every destination edited in the current product. Scope navigation holds while a sheet edit is open or unconfirmed.
- `useCellFormulas.ts` and `formulaWrites.ts` report formula saves, replacements and removals before enqueueing, including drawer actions that bypass the ordinary grid writer.
- `drawer/idleCommit.ts` and `RecordField.tsx` drain the last debounced edit when leaving the drawer or preparing publication. Escape and switching to formula mode cancel the timer, so a discarded draft cannot be saved by a stale timer.
- `studio-publication.service.ts` rechecks saved facts after acquiring the publication claim, records provider receipts before read-back/local projection, preserves eBay warnings, and recovers an acknowledged eBay item using the exact account/market/alias without resending. It verifies every local projection row before completing recovery. A terminal processing report cannot be overwritten by a slower submit response. Interrupted sends without a receipt become explicitly unverified after 30 minutes and continue to block blind resubmission.
- `studio-publication-amazon.ts` leaves FATAL feeds unresolved without conclusive per-message evidence, rather than incorrectly declaring every SKU failed. Amazon states that some, none or all operations may have completed and a report may not exist: [official Feeds guide](https://developer-docs.amazon.com/sp-api/docs/submit-a-feed).
- `studio-publication-ebay.ts` separates send acknowledgement from same-account GetItem read-back and carries warnings through the result. eBay Warning can indicate that a submitted value was changed: [official acknowledgement semantics](https://developer.ebay.com/DevZone/XML/docs/Reference/eBay/types/AckCodeType.html).

## Measured result

Disposable PostgreSQL (PGlite with the generated production Prisma schema), two family rows, two eBay accounts, three markets, four languages. The regression independently reads stored price/version, proves unrelated readiness rows are unchanged, verifies broad shared edits, and refuses a stale listing version.

| Same materializer, same fixture | Trial 1 | Trial 2 | Trial 3 | Median |
| --- | --- | --- | --- | --- |
| Unscoped readiness | 236 ms | 225 ms | 232 ms | 232 ms |
| Scoped readiness | 56 ms | 56 ms | 64 ms | 56 ms |

Readiness sheet resolutions fell from **12 to 2** (83% fewer). The comparable materializer median fell by **76%**. One complete scoped bulk save, including persistence and derived work, took **150 ms**. These are local synthetic measurements, not production p95 or a promise for a 21-row live family. The already-scoped localized title path needs a production timing check separately.

Reproduce the optional measurement with:

```sh
AUTOSAVE_PROFILE=1 npm test --workspace=@nexus/api -- src/services/pim/autosave-readiness.vitest.test.ts --maxWorkers=1
```

## Initial fix verification and limits

- API regressions: **143 passing tests in 9 files**, including disposable database tests for autosave and publication receipt recovery. Tests use mocked channel transports and never publish listings.
- Web regressions: **178 passing tests in 14 files**, covering sheet ordering/recovery, save ledger, publication selection, drawer debounce and formula queue. Combined API/web total at that checkpoint: **321**. The additional Publish audit below extends that review and verification.
- API/web typechecks and shared-package build pass. Token generation and raw-control ratchet pass; no shared design-system files changed.
- Browser: the updated local studio loads without observed console errors; the publication modal fits desktop 1728×906 and mobile 390×844, with no horizontal overflow. Light/dark presentation, Escape dismissal and focus return to Publish were checked. The local Amazon account is disconnected, so no live save or publication was attempted from that page.
- The unattended `check-editor-open.mjs` gate stops before testing because no `STUDIO_STORAGE_STATE` or test sign-in credentials were supplied. This is an unexecuted gate, not a pass. Existing authenticated-browser checks above provide narrower evidence.
- One initial concurrent Vitest run reported an `EnvironmentTeardownError` while closing console RPC despite passing assertions. The complete API selection subsequently passed serially with no unhandled errors; no test was skipped or weakened.
- Changes are local and uncommitted. No production deployment or marketplace mutation has occurred. Actual provider receipt, full field parity and production latency require a controlled live verification of an agreed listing after deployment. A crash between provider acknowledgement and durable receipt remains an uncertain distributed-system outcome; it is held for reconciliation, never blindly retried.

This is tested corrective work, not an assertion of perfect operation or an AAA accessibility certification.

## Follow-up: Publish flow and deployed build

Graphify was used again to trace `PublishDialog` → product studio routes → `submitStudioPublication` / `studioPublicationResult` → channel transports. The existing graph is a baseline index; every finding was checked against current source. Relevant commands:

```sh
graphify query 'PublishDialog submitStudioPublication studioPublicationResult channel delivery' --budget 1600
graphify explain 'apps/api/src/services/pim/studio-publication.service.ts::submitStudioPublication'
graphify explain 'apps/api/src/services/pim/studio-publication-plan.ts::readPublicationFacts'
graphify affected apps_api_src_services_pim_studio_publication_service_studiopublicationresult --depth 1
```

Five additional defects were reproduced and corrected locally:

| Defect | Correction and files |
| --- | --- |
| A missing HTTP response could leave the Publish modal busy indefinitely. | `publication/request.ts` bounds submission/preview waits to 120 seconds and status reads to 30 seconds, propagates cancellation and preserves HTTP error status. `PublishDialog.tsx` retains uncertain submissions for status checking. No automatic retry is added. |
| A database outage after a provider acknowledgement could hide the known receipt behind an HTTP error or a later empty status response. | `studio-publication.service.ts` returns the known reference as UNVERIFIED if final persistence fails, including Amazon, eBay and Shopify. `publication/model.ts` and `PublishDialog.tsx` preserve that receipt and warnings when the same operation's next status response has no provider results, while accepting authoritative replacement results. They do not claim durable recording or resend. |
| Amazon reports without SKU strings could mark every row failed or accepted despite mixed results. | `amazon-flat-file-feed.service.ts` accepts an optional submitted message-ID map. `studio-publication-amazon.ts` correlates the exact feed message order and requires consistent processed/accepted/invalid counts and mapped mixed failures before concluding. Incomplete evidence remains pending. |
| eBay duplicate acknowledgements could be labelled “Nothing was submitted” even when an earlier request created the item. | `ebay-trading-api.service.ts` attaches typed duplicate metadata. Error 488 requires same-app evidence and a numeric prior item ID; a duplicate revision requires matching InvocationID and Success. `studio-publication-ebay.ts` retains a validated receipt; ambiguous duplicates stay unverified and block blind resubmission. |
| An eBay single-SKU price or quantity changed after review could be overwritten without a stale-review refusal. | `studio-publication-ebay.ts` includes item-level price/quantity and explicit editable payload fields in its remote revision digest. Unchanged revisions proceed; changed price or quantity blocks before Revise. Sold counters remain excluded. |

Provider contracts were checked against the [Amazon processing-report schema](https://github.com/amzn/selling-partner-api-models/blob/main/schemas/feeds/listings-feed-processing-report-schema-v2.json), [eBay duplicate UUID response example](https://developer.ebay.com/support/knowledge-base/1462), and [eBay UUID/InvocationID documentation](https://www.developer.ebay.com/api-docs/user-guides/static/make-a-call/tapi-input-data.html). An eBay receipt plus Active read-back confirms acknowledgement and current listing status; it does not prove complete post-normalization field parity.

The production API readiness endpoint returned `healthy`, with database connected and build **5fa63d31** (`5fa63d310bc56f1f9fabc372537f650161ea0341`). Inspection of that commit confirms it predates these corrections. Local HEAD is `6cda1d1e60b9d631dbfc941a2562a942e5efedcb`; the corrections are uncommitted working-tree changes. Recent Railway entries marked SKIPPED are not evidence of successful deployment.

Final follow-up validation: **245 API tests in 15 files and 186 web tests in 16 files passed (431 total)**. This includes the shared Amazon report parser and eBay Trading client callers, plus disposable PostgreSQL receipt recovery and autosave tests. API/web typechecks and `git diff --check` pass. Independent review found the receipt-erasure issue above; its correction and Shopify fallback were re-reviewed with no further material issue found. The database suites initially could not open a local socket inside the sandbox (`EPERM`), so they used approved access outside the sandbox. A concurrent final run also hit the previously observed Vitest console teardown error; the complete API selection then passed alone with exit code 0 and no unhandled errors. Channel transports remained mocked. Logs: `/private/tmp/nexus-publication-api-final.log`, `/private/tmp/nexus-publication-web-final.log`, and corresponding `*-types.log` files.

No production deployment or marketplace write was performed. The earlier browser checks remain applicable because this follow-up changes request handling and backend behavior, with no layout or shared design-system changes. The remaining release evidence is deployment of these changes, a controlled live publication through the selected account/market/listing, provider processing/read-back, and production save-latency measurement. Direct publication to Etsy/WooCommerce remains explicitly unavailable in the existing flow; this correction does not add those integrations.

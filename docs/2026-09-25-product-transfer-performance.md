# Product-sheet import and export performance — 2026-09-25

The changes remove repeated database work while keeping workbook validation,
destination boundaries, record-version checks and transactional apply behavior.
They are local changes; production speed has not been verified after deployment.

## Reproduced costs and changes

| Case | Before | After | Decision |
| --- | --- | --- | --- |
| Import context: 2,501 attributes addressing three channel/market coordinates | 2,501 marketplace OR predicates | 3 predicates; identical active-market results | Keep: deduplicate coordinates before querying |
| Import review: 25 changed listing titles | 25 extra marketplace reads | 0 extra reads; identical effective values | Keep: use the language authority already loaded for the preview batch |
| Effective-value export: 25 products, three account/alias/category destinations, two languages | 150 resolver calls | 6 calls; all 150 output values retained | Keep: batch within each 100-product page by channel, market, account, alias, category and language |

These are deterministic work-count measurements, not production latency or SQL
query-count claims. Each regression test failed on the original implementation
and passed after its change. Export results are matched by product ID, even if
the resolver returns products in a different order. Output listing/language
order remains unchanged. The export optimization applies to effective-value
downloads; editing workbooks retain their existing generation path.

The preview language data is scoped to the current context. No global cache or
staleness window was added. Apply still reloads records, re-plans reviewed
changes and checks boundaries inside its existing transactions.

## Workbook CPU measurements

Three passes per case on the local machine, using real `writeCatalogWorkbook`,
ExcelJS load and `readCatalogWorkbook` with a v3 editing baseline. No database
queries. All attributes round-tripped with zero issues.

| Fixture | XLSX generation | XLSX load | Parse and checks | File size |
| --- | --- | --- | --- | --- |
| 100 SKUs × 300 fields, 20 fields with 1,000 choices each | 430–491 ms | 133–160 ms | 130–148 ms | 477,736 bytes |
| 50 SKUs × 950 fields, 20 fields with 10,000 choices each | 1,212–1,303 ms | 384–437 ms | 189–256 ms | approximately 1.79 MB |

CPU profiling showed ExcelJS XML/style/address processing, ZIP compression and
garbage collection as major costs. Repeated header parsing and field lookups
exist, but the measured parse/check stage was at most 256 ms. These measurements
do not justify removing checks or rewriting workbook handling. No such change
was made. The profiling script and CPU profile are in
`/private/tmp/catalog-workbook-profile.mts` and
`/private/tmp/catalog-workbook-profile.cpuprofile`.

## Production observations and limits

Read-only Railway HTTP logs for the current deployment showed three recent
catalog import submissions taking 2,080, 5,563 and 2,286 ms. Apply requests
returned accepted responses in 505 and 526 ms. Those responses acknowledge
background jobs; they do not measure completed review or save time. No export
request was present in the returned sample. Therefore these observations do
not establish the cause or duration of the user's full live wait.

## Verification

- Import planner, jobs, transactions and new performance regressions: 95 passed.
- Transfer HTTP routes, channel-file routes, uploads, downloads, exports,
  workbook formats, product boundaries and parse-worker containment: 121 passed,
  three existing opt-in tests skipped, before the effective-export batching change.
- Effective-export batching and download regressions: 16 passed.
- Final affected HTTP/export/performance tests: 17 passed, one existing opt-in
  browser-fixture test skipped. API typecheck passed. Logs:
  `/private/tmp/nexus-transfer-typecheck.log` and
  `/private/tmp/nexus-transfer-final-tests.log`.

Tests use isolated stores and the repository's local-database guard. Background
Redis connections emitted sandbox `EPERM` messages in the broader passing suite;
that run does not establish Redis connectivity. No production data was changed.

Focused reproduction commands, run from `apps/api`:

```sh
../../node_modules/.bin/vitest run src/services/pim/catalog-transfer-performance.vitest.test.ts src/services/pim/catalog-transfer-export.vitest.test.ts
npm run typecheck
```

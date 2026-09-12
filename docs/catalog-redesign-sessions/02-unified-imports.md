# Session 2 prompt — unified imports and external-source ownership

Workspace: `/Users/awais/nexus-commerce` (or the coordinator's verified snapshot of its current uncommitted source).

Read `docs/catalog-redesign-sessions/README.md`, repository instructions, `docs/2026-09-06-catalog-workspace-redesign.md` and `handoff-01.md`. Implement this task once session 1 explicitly marks the account/write contract usable. Before that, inspect and record findings in your own handoff without guessing dependent contracts.

Preserve the efficient shared grid and current mapping work. Secondary navigation belongs only to product editing; do not add it to catalog-transfer or Products Next. Use the Nexus design system for changed UI, read its sources, use semantic tokens and coordinate required Factory/catalog/changelog/DS-GAPS changes.

## Objective and existing foundation

One upload or external-source import must update shared product facts and explicit scoped overrides through one mapping → preview → apply workflow. Existing catalog-transfer supports a mixed long-format CSV/workbook, stable identities, explicit SET/CLEAR/INHERIT semantics, conservative blanks and durable BulkOperation processing. Reuse it. Generic source-column mapping/import presets and older ImportJob/ScheduledImport ownership are the remaining integration work.

## Inspect and implement

1. Inspect `apps/web/src/app/products/catalog-transfer`, `packages/shared/catalog-transfer.ts`, `apps/api/src/routes/catalog-transfer.routes.ts`, `apps/api/src/services/pim/catalog-transfer*`, `pim/import-jobs.service.ts`, existing `/api/import-jobs` handlers, ImportWizard, `scheduled-import.service.ts`, related jobs/routes and current persistence models. Follow actual registrations rather than relying on route names in old documents.
2. Support an ordinary wide source file through reusable mappings/import presets: incoming source column → shared fact versus incoming column → explicit channel/account/market/listing override. Reuse compatible field definitions and validation from the canonical mapping/write services. Outgoing shared-to-channel rules remain a distinct operation; do not create a competing resolver.
3. Keep product/variant identity stable. Omitted columns and blank cells preserve existing values by default. Explicit clear and restore-inheritance actions must remain distinct. Shared updates preserve existing overrides. Detect conflicting input rows targeting the same shared field; do not choose the last row silently.
4. Preview exact destinations, affected product/listing totals, new overrides, changes, preserved overrides, conflicts, exclusions and validation failures. Never label a sample as the total. Allow drilling into complete paginated outcomes. Separate table export from an editable round-trip catalog export.
5. Route manual import, external-source and scheduled updates through declared ownership and the established validated write path. Inspect legacy writers for unversioned overwrites and direct stock/price writes. Enforce the appropriate inventory/pricing owner instead of accepting those fields merely because an old importer did. Source policies must be explicit and previewable.
6. Bind preview/apply/jobs to explicit destinations and input/record versions. Refuse stale reviews and conflicting writes. Large parsing/preview/apply work needs bounded memory, chunking, durable progress, safe retries and per-record outcomes using current infrastructure. Do not require multiple sheets/files for ordinary mixed updates.

## Ownership

Own catalog-transfer/import UI, import services/jobs/routes, source preset behavior and their tests. Coordinate `packages/shared` exports and schema changes. `product-studio.routes.ts`, core write routes/resolvers and Studio shell contracts remain coordinator-owned after the readiness handoff; provide small exact integration patches when needed. Do not edit mapping configuration/presentation or wizard/publishing code owned by other sessions.

## Verification and handoff

Use isolated representative CSV/XLSX and external-source fixtures with thousands of products/variants, multiple accounts/markets, blank/omitted cells, explicit clears/resets, mixed shared/scoped columns, duplicate conflicting targets, stale versions, partial failures and retries. Verify a shared change is reflected through the canonical mapping without duplicating channel facts. Verify no override or stock/price owner is silently overwritten. Measure parsing/preview memory and bounded database/query behavior; small working-catalog speed is not a scale test.

Run focused import/write tests and API/web type checks; check the complete browser upload → mapping → preview → apply flow in an isolated environment, including keyboard, narrow layouts and both themes. No live catalog fixtures or marketplace publication. Record changed files, reusable contracts, actual results, migrations/integration needs and remaining limitations in `handoff-02.md`. Integrate required route/permission patches before claiming a working import experience.

## Current entry-point checks from Session 1

Inspect channel-sheet export/import destinations before labeling a file editable or importable: the legacy keyed table export omits account identity. A named-account table must not be imported into the primary account by inference. The core write contract is ready, but this consumer limitation remains yours to resolve. Keep source mapping, shared-to-channel rules and explicit override import distinct. Send changes needed in `ChannelSheet.tsx`, `useChannelSheet.ts`, shared types or core routes back to the coordinator as an exact patch.

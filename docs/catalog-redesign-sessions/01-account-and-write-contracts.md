# Session 1 prompt — account scope and write consistency

Workspace: `/Users/awais/nexus-commerce` (or the coordinator's verified snapshot of its current uncommitted source).

Read `docs/catalog-redesign-sessions/README.md`, repository instructions and `docs/2026-09-06-catalog-workspace-redesign.md`. Implement this work; do not stop at a proposal. This is the coordinating session's task. Do not run another writer for it simultaneously.

Preserve all existing work and the shared design-system grid. Product editing is the only secondary-sidebar workspace. UI changes must use Nexus DS components and semantic tokens, with required Factory/docs mirrors. Inspect the real current implementation before choosing changes.

## Objective and existing foundation

Make account coordinates and field write ownership reliable across core product/channel reads and writes. The channel sheet already carries optional account IDs and per-cell write targets; the resolver and backend validation already exist. Some ancillary flows still use primary-account services. Extend those foundations; do not invent another resolver, precedence stack or grid.

## Inspect and implement

1. Trace `connection-resolver.service.ts`, `pim/product-category-context.ts`, `pim/studio-sheet.service.ts`, `routes/product-studio.routes.ts`, `routes/products.routes.ts`, Studio `contracts.tsx`, `StudioTabHost.tsx`, `sheet/channel` reads/commits and shared SheetWriter contracts. Follow actual callers, including aliases, formulas and category-dependent columns.
2. Establish one documented coordinate: product/family, channel, account/connection, market, applicable language, listing/alias and field where relevant. Keep public URL/body names compatible or explicitly document changes. Validate named accounts against the channel and active connection. Never silently turn ambiguous accounts into an unattributed write or silently select another store.
3. Reads of columns, rows, categories, formulas, effective values and overrides must use the same destination. Inspect missing/null account behavior and unattributed legacy records before narrowing queries; refuse ambiguity and preserve supported disconnected draft behavior. Query by exact ownership rather than omitting a filter when an ID is absent.
4. Preserve field-specific inheritance and actual write targets. Shared facts remain shared, mappings transform values, and permitted listing customizations remain scoped. Reset explicitly restores current inheritance. Do not weaken pricing/inventory ownership. Use existing versions/CAS, validation, conflict feedback and write services for manual edits, paste and bulk operations.
5. Prevent stale requests, pending edits, cached rows and save responses crossing product/account/market/listing changes. Retain grid keyboard editing, expansion, selection, paste, views, column controls and performance.
6. Produce a capability matrix for Information, Presentation, Media, readiness/issues, activity, imports/exports and wizard/publishing. Implement core scope support here. Imports are session 2 consumers, Presentation is session 3, and wizard/publishing is session 4: hand off concrete API contracts and required call-site fixes. Until a consumer is wired, keep an accurate restriction that cannot fail open for multiple accounts with no unique primary. A guard is not completion of account support.

## Ownership

Own core connection resolution, product write routes and Studio account contracts, plus focused tests. Own `product-studio.routes.ts` while other sessions need changes in its import or publishing sections; integrate their exact patches sequentially. Do not edit mapping rule configuration, import implementations or wizard consumers while their owners are working. Coordinate DS, schema, API-registration and permission changes through the README protocol.

## Verification and handoff

Use isolated tests with two accounts on the same market, multiple/no primaries, disconnected/invalid/cross-channel IDs, identical aliases on different accounts, and legacy unattributed records. Verify explicit account requests succeed without evaluating unrelated ambiguous channels, Shared edits do not depend on channel configuration, columns/rows agree, and a late save/read cannot affect another scope. Exercise partial overrides, restoring inheritance, validation refusals and concurrent writes.

Run focused API/web tests and type checks; browser-check changed scope/guard UI using real connected read-only data and isolated writes only. If changing DS, run token/mirror and responsive light/dark/keyboard checks. Record exact files/commands/results and unresolved consumers in `handoff-01.md`. State which contract is ready for sessions 2 and 3, and which work remains; do not mark the whole redesign complete.

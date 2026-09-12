# Category taxonomy implementation and verification

Implemented 2026-09-11. The main application entry is **Products → Categories**, `/catalog/categories`. This is shared catalog administration, accessible from the Products navigation and the product editor’s channel category picker. It is separate from the product-edit sub-sidebar.

Local rollout is complete: the migration is applied to the API development database, all **18 connected selling scopes** have current reference trees (**104,438 nodes**), and the running application was checked against those real caches. Production has not been deployed.

## Components and behavior

| Section | Components | Behavior |
| --- | --- | --- |
| Our categories | PageHeader, Tabs, Input, Listbox, DataGrid, Menu, Pagination, Modal, Field, KeyValue, Banner | Search names, complete paths and codes; filter active/inactive; inspect direct product counts; open children; create, rename, move and delete empty categories. Review affected products and descendants before saving. |
| Channel assignments | Channel/market selector, assignment table, status pills, searchable taxonomy dialog, cached requirement preview, existing ImpactReview | Show direct/default/inherited assignments and requirement health. Search complete marketplace paths and exact IDs. Review catalog impact before activation. Follow contextual links to the existing attribute/formula editor. |
| Taxonomy updates | Channel status table, refresh actions, browse dialog, import history | Inspect cache coverage, tree changes, last success and provider errors. Queue background tree/requirements refresh. Browse the previous successful tree while imports run or fail. |

The interface uses Nexus primitives and semantic tokens. New controls are not styled independently in feature CSS. `Tabs overflow="scroll"` is a shared addition, mirrored in Factory with catalog/changelog documentation and a DS-GAPS record. It preserves roving focus and makes long labels reachable in narrow containers. Results are capped at 50 rows per page; requirement previews display ten fields with a link to the complete mapping workspace.

Internal category changes include a directory revision check. Names preserve existing translations, stable IDs survive renaming, sibling URL keys are checked, cycles are refused, and empty-category deletion checks children, memberships and channel assignments. Tree edits, classification changes, category imports and reviewed mapping activation share a business-scoped transaction lock. Membership changes and their product audit events commit together in the category service, and advance the product revision so an open classification form cannot overwrite newer membership changes. A move that would change inherited channel assignments is blocked until explicit assignments have been reviewed; the page does not silently reclassify that subtree.

Assignment review reuses the existing durable catalog scan, input fingerprint, serializable activation and mapping audit. The selected taxonomy revision and cached schema are checked; activation refuses a replaced tree or expired requirements. Existing listing overrides are preserved. Reference-data refresh does not publish products or overwrite assignments. Retired categories and missing/expired requirements remain visible. Switching businesses remounts the workspace and discards the previous business’s loaded data.

## Channel adapters

| Channel | Local reference data | Requirements |
| --- | --- | --- |
| Amazon | Product-type discovery by configured marketplace ID, using an account in the configured region | Cached product-type definitions. Product types and browse nodes remain distinct; seller-specific eligibility still belongs to account-aware publishing/preflight. |
| eBay | Full category tree, after discovering its marketplace tree ID | Existing category-aspect and condition-policy cache. Only assignable leaves can be selected for an assignment. |
| Etsy | Full seller taxonomy with original numeric IDs preserved as strings | Existing cached seller-taxonomy properties, including their values/scales. |
| Shopify | Published standard taxonomy release, including category attribute metadata | Standard category attributes are separate from store-specific metafield definitions and validation. |

The page is driven by configured marketplaces/connections and the provider registry in `apps/api/src/services/taxonomy/providers.ts`. Additional channels appear with an explicit “Adapter required” state until their provider adapter is implemented. Adding a channel needs its actual taxonomy/requirements adapter; it does not require another page or navigation implementation. A country-based connection without a configured market is shown as “Market required.”

The connected local scope is Amazon (11 European markets), eBay (DE/ES/FR/IT/UK), Etsy and Shopify. WooCommerce has a marketplace configuration but no active connection or taxonomy adapter; it remains explicitly unavailable. Advertising connections are excluded from the selling-category directory.

## Ingestion and storage

Three new workspace-scoped models store sources, import snapshots and nodes. The migration installs PostgreSQL trigram indexes, row-level security, business-reference guards and an active-revision guard. A source can activate only its own complete snapshot.

The worker enrolls configured supported sources, processes at most two sources per tick, imports complete trees daily, and refreshes requested/in-use requirement caches in batches of 25. The queue is persisted in PostgreSQL, with lease tokens, lease renewal, versioned requests and exponential retry delays. A concurrent request cannot be cleared by an older worker. A failed requirements category moves behind unprocessed work; retired nodes are reported and removed from immediate retry work. Interrupted staged imports are recorded as failed after their lease is recovered.

Imports validate identities, duplicates, parent references, cycles/depth and suspicious large truncation before activation. All node batches finish before the active snapshot changes. Matching content reuses the current snapshot, avoiding a daily copy of an unchanged tree. Three recent successful trees are retained; older node payloads and failed payloads older than one day are pruned, while import summaries remain available.

Search and requirement preview in Categories use the local database. Product-edit category autocomplete and Shopify standard-category reference search also use that local source. Shopify pagination pins its revision and query. Existing provider calls for account-specific preflight, explicit schema refresh, publishing and reconciliation still have their own responsibilities.

Search keeps hot copies of immutable database revisions: at most 32 revisions within an estimated 128 MiB, with ten-minute idle expiry, 64 cached pages per revision, LRU eviction and at most two concurrent revision loads. Concurrent searches share a revision load. Every request first reads the current source through business/actor RLS; revocation and revision replacement are never cached. Search is case-insensitive, matches complete paths and IDs literally, preserves database ordering, and returns at most 50 rows. Large revisions exceeding the memory budget are served without being retained.

Connected checks found and fixed two runtime defects that the initial mocked tests missed: the workspace database wrapper does not expose Prisma field references, and the Amazon SDK requires the selected seller’s refresh token even when automatic renewal is disabled. The worker now compares request revisions on the small configured source list; Amazon passes the verified account’s grant to the real SDK and keeps renewal in CX.

## Verification

- **156 API tests across 20 files**, covering taxonomy parsing/storage lifecycle, durable requests, category moves/revisions, mapping resolution and activation, Amazon/eBay/Etsy schema behavior, classification/import transactions, Shopify references, the real Amazon SDK constructor, cache isolation/eviction and simultaneous loads. **8 product-picker tests** also pass. The actual impact worker is exercised with mocked persistence/resolution at both 2,500 and 10,000 products: two accounts, 100-record batches, complete counts and preserved overrides.
- Full API and web TypeScript checks passed. Subsequent scoped checks include the changed application files, new tests and Web/Factory tab examples.
- Token generation checks pass in Web and Factory. Both token guards, CSS parse checks and the raw-control ratchet pass. Direct checks also cover the new, untracked feature files: all CSS tokens exist and all controls use Nexus components.
- The **design-system fork guard passes**. Factory’s export index differed only in blank lines; those were aligned without changing exports. Two already-converged files were removed from the drift baseline. The remaining seven historical differences remain within the existing baseline.
- The real migration was exercised in isolated PostgreSQL via PGlite: business isolation, actor membership, cross-business reference refusal, incomplete-revision refusal, atomic activation and duplicate external IDs passed. See [database evidence](database-evidence.json).
- The initial single-connection PGlite check measured **71.13 ms** p95 for a 100,000-node SQL fixture. Native PostgreSQL testing then exposed repeated scans and JIT overhead: the original API search reached **20,150 ms** p95 with 50 clients. The hot-revision cache fixes that bottleneck without changing RLS or the one-connection pool. See [baseline evidence](load-baseline-evidence.json).
- The final load check uses disposable **PostgreSQL 17**, real Fastify handlers through injection, the real Prisma workspace runtime and authenticated business RLS, with **100,000 nodes**. Warm repeated searches at 50 clients measured **11.97 ms p95**; **50 distinct searches** against the loaded revision measured **127.49 ms p95**. Loading the revision from an empty process cache took **1,956.50 ms**. Cross-business reads, revoked actors against warm data and outdated snapshot requests were refused. These are local measurements, excluding browser/network time and unrelated production workload. See [load evidence](load-evidence.json).
- Shopify’s actual published **2026-08** asset parsed **14,606 categories**, 26 roots and 14,454 categories carrying attribute metadata. The artifact URL and SHA-256 are recorded in [release evidence](shopify-release-evidence.json).
- Browser verification used real production React components with isolated API fixtures: create/review/save and search; Escape/dirty-discard; retired-category warning; keyboard autocomplete; requirements refresh and review gating; catalog-impact activation; import history; light/dark and 390px presentation. Narrow document overflow was found and fixed (435px → 390px). The assignment dialog measured 350px within that viewport. See [desktop status screenshot](desktop-taxonomy-updates.png).
- The running local application also showed all 18 imported scopes, its real internal category directory, and keyboard selection of eBay UK Racing & Riding Suits. Refreshing that category completed through the durable worker and displayed **29 fields, two marked required**. See [live requirement preview](live-ebay-requirements-dark.png) and [live category directory](live-categories-light.png). One-result search copy was corrected to “1 match.”
- Keyboard navigation uncovered a shared-shell defect: the rail expanded for keyboard focus but still hid its sub-links. The collapsed-content selectors now respect the existing focus-visible expansion. Products → group toggle → Categories → Enter was verified in the running application. Expanded rail width is viewport-bounded; Factory has no copy of this application shell.

The browser fixture’s product counts and mapping review are synthetic. They verify UI flows, not a live 10,000-product scan. No live marketplace products were published or modified during these checks.

## Rollout requirements

The migration is **applied to the local API development database**, with Prisma’s recorded checksum matching the source file. A restricted runner staged only this migration after verifying the workspace-isolation prerequisite; unrelated pending migrations were not applied. See [local readiness evidence](local-readiness-evidence.json). The production API is a separate Railway deployment and has not been changed. Ship database and API/web changes together through the normal migration/deployment workflow, with the migration before the updated workers and pickers start. `NEXUS_ENABLE_TAXONOMY_REFRESH_CRON=0` pauses the new scheduler when needed.

Authenticated Amazon/eBay/Etsy reference downloads and requirement refreshes succeeded from the local development runtime, using its connected accounts; Shopify’s published taxonomy was also ingested. Every connected scope is ready in [connected evidence](connected-evidence.json). Repeat these checks in the deployed environment, including quota behavior and memory under real mixed traffic. The local catalog contains 338 products; a live 10,000-product impact scan remains a separate rollout check. Existing marketplace preflight and asynchronous publication reconciliation remain necessary.

## Reproduce isolated checks

```sh
node docs/audits/2026-09-11-category-taxonomies/verify-database.mjs
node docs/audits/2026-09-11-category-taxonomies/local-readiness.mjs
node docs/audits/2026-09-11-category-taxonomies/migrate-local.mjs
node_modules/.bin/tsx docs/audits/2026-09-11-category-taxonomies/verify-shopify-release.mts /path/to/categories.en.json.gz
node docs/audits/2026-09-11-category-taxonomies/browser-fixture/server.mjs
```

Run `verify-connected.mts --ingest --requirements` and `verify-load.mts` with `../../node_modules/.bin/tsx ../../docs/audits/2026-09-11-category-taxonomies/<script>` from `apps/api`. Both refuse remote database targets. The former reads real marketplace reference data and writes the local cache; the latter creates and removes its own isolated synthetic PostgreSQL database.

The browser fixture serves `http://127.0.0.1:3155/catalog/categories`, uses no production credentials, and keeps synthetic mutations in memory.

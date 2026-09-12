**Category taxonomy: architecture and implementation recommendation**

Date: 2026-09-11. Status: implementation added following this plan. See the [implementation and verification report](audits/2026-09-11-category-taxonomies/README.md) for delivered behavior, measured results, the remaining live rollout gates and limitations. The architecture and proposed scale targets below record the original design intent; they are not a claim of completed production validation.

**Recommended placement**

Create a dedicated **Products → Categories** workspace at `/catalog/categories`, accessible from the Products secondary navigation. Categories affect many products and need room for search, hierarchy, coverage, and change review.

| Surface | Responsibility |
| --- | --- |
| Products → Categories: Our categories | Create and organize internal categories; inspect primary memberships, descendants, product counts, and inherited assignments. |
| Products → Categories: Channel assignments | Assign internal categories to marketplace categories; show channel/market scope, schema readiness, overrides, and affected products; review changes before activation. |
| Products → Categories: Taxonomy updates | Inspect reference-data freshness, import failures, removed categories, changed requirements, and affected assignments. Request background refresh and review replacements. |
| Existing Mappings workspace | Continue authoring master-attribute mappings, value transformations, and formulas. Open it from a category assignment with channel, market, account where relevant, and schema context already selected. |
| Product editor → Information | Show this product's internal primary category and effective marketplace assignments, inheritance source, explicit overrides, and readiness. Provide links to manage the shared category or its attribute rules. |

Keep one category-assignment editor: the current category modal in Mappings should eventually open the Categories workspace in context. Product-level overrides stay local to the product/listing; changing a shared mapping must clearly show its catalog-wide impact. Preserve the return path and unsaved-edit guard when navigating from the editor.

The existing `/catalog/organize` page handles grouping and parents; category taxonomy should have its own route and clear name. This recommendation does not require a new top-level global navigation item or another product-editor tab.

**Provider contracts and corrections to the research**

Background ingestion and local reads are the right target. A single universal tree-plus-JSON-Schema importer will not represent every provider correctly:

| Provider | Required distinction | Recommended ingestion |
| --- | --- | --- |
| Amazon | Product type selects requirements; browse nodes describe classification. A browse leaf is not itself a universal schema key. Generic schemas and seller-specific schemas have different scope. | Persist product-type discovery and supported browse-node data separately. Refresh definitions for used/mapped types first, then expand coverage. Store downloaded schema documents and their provenance. |
| eBay | Category tree, category aspects, and listing policies are distinct datasets. | Discover the marketplace tree, ingest the hierarchy, bulk-download leaf aspects where available, and ingest relevant metadata policies. Preserve complete provider constraints. |
| Etsy | Seller taxonomy and per-node properties are separate resources; properties carry IDs, values, and scales. | Ingest the full seller taxonomy; prefetch properties for mapped/in-use categories and hydrate the remainder in bounded background work. |
| Shopify | Standard product taxonomy differs from merchant collections, free-text product type, and store-specific metafield definitions. | Cache standard categories/attributes independently from account-scoped definitions and validation constraints. |

These distinctions follow the [Amazon listing guide](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide), [Amazon definition retrieval guide](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/retrieve-a-product-type-definition), [eBay migration roadmap](https://developer.ebay.com/api-docs/commerce/static/migration-roadmap.html), [Etsy reference](https://developer.etsy.com/documentation/reference), and [Shopify taxonomy documentation](https://shopify.dev/docs/api/admin-graphql/latest/objects/taxonomy).

Use provider-specific schedules and freshness policies. As an initial operational proposal, check supported versions/notifications daily, refresh used requirements daily, and run periodic full reconciliation. Tune this to measured quotas and provider behavior. Amazon exposes definition-change notifications; eBay offers expired-category replacement metadata. A calendar-only monthly refresh is insufficient as the sole mechanism for detecting changes. [Amazon notifications](https://developer-docs.amazon.com/sp-api/docs/notification-type-values), [eBay taxonomy changes](https://developer.ebay.com/api-docs/commerce/taxonomy/static/release-notes.html).

Marketplace calls also belong in background refresh, account-specific preflight when needed, publishing, and subsequent result reconciliation. Amazon supports validation preview without creating a listing. Cached validation cannot prove seller eligibility or final acceptance, and an accepted submission can still develop asynchronous issues. [Amazon validation preview](https://developer-docs.amazon.com/sp-api/docs/sp-api-release-notes?ld=SDESSOADirect), [Amazon listing lifecycle](https://developer-docs.amazon.com/sp-api/lang-en_EN/docs/manage-product-listings-guide).

**What exists in Nexus**

| Finding | Evidence | Implication |
| --- | --- | --- |
| Internal categories, a closure table, memberships, and channel mappings already exist. | [Database models](../packages/database/prisma/schema.prisma), [category service](../apps/api/src/services/category-tree.service.ts) | Extend these identities and relationships. Avoid introducing a second internal taxonomy. |
| Batch resolution supports primary categories, ancestor inheritance, listing overrides, and conflicting memberships. | [Category resolver](../apps/api/src/services/pim/mapping/category-mapping.service.ts) | Reuse one resolver in the editor, mapping preview, bulk operations, and publishing. |
| Mapping reviews already scan inputs, preserve overrides, and reject changed inputs before activation. | [Impact service](../apps/api/src/services/pim/mapping/impact.service.ts) | Extend the existing review and revision mechanism to taxonomy revisions and category-tree changes. |
| Category assignments currently use free-text channel IDs in a modal. | [CategoryMappingPane](../apps/web/src/app/channels/mapping/_shared/CategoryMappingPane.tsx) | Replace this with validated searchable references, breadcrumbs, and readiness. |
| eBay search calls its suggestion endpoint on a process-cache miss. | [eBay category service](../apps/api/src/services/ebay-category.service.ts) | Normal category search currently depends on provider availability. |
| Etsy taxonomy and Amazon product-type discovery use memory caches. Shopify category search queries GraphQL. | [Etsy taxonomy](../apps/api/src/services/etsy/taxonomy.ts), [product types](../apps/api/src/services/listing-wizard/product-types.service.ts), [Shopify gateway](../apps/api/src/services/shopify/linked-products-gateway.ts) | Persist reference data and switch interaction paths to local reads. |
| Category schemas for Amazon/eBay/Etsy persist in PostgreSQL, but expiry/misses can trigger provider requests. | [Schema service](../apps/api/src/services/categories/schema-sync.service.ts) | Split cached reads from worker refresh. Expose missing/stale/refreshing states explicitly. |
| The inspected scheduled schema refresh covers active cached Amazon types and is gated by an environment flag. | [Refresh job](../apps/api/src/jobs/schema-refresh.job.ts) | Add channel coverage, durable import tracking, and verify enabled configuration during rollout. Source registration alone does not prove it runs. |
| Generic Amazon schemas are deliberately marketplace-wide; seller ID is omitted. | [Schema service and provenance](../apps/api/src/services/categories/schema-sync.service.ts) | Retain that distinction. Add separately scoped seller requirements where needed rather than implying the generic schema is complete for every account. |
| Mapping target validation checks for an active schema row; it has no persisted external tree membership to validate. | [Impact creation](../apps/api/src/services/pim/mapping/impact.service.ts) | Validate target existence, assignability, scope, and exact requirements revision before activation. |
| Product membership primary selection is service-managed; removal and replacement-primary selection use separate operations. | [Category service](../apps/api/src/services/category-tree.service.ts) | Audit concurrent assignment/removal. Require an atomic membership update with explicit conflict handling and a database constraint allowing at most one primary. |

The inspected category schema model has content versions and active flags, but no single authoritative active-snapshot pointer. New ingestion needs explicit publication of complete revisions so request timing cannot select a partially imported or superseded reference set.

**Data and ingestion design**

Use PostgreSQL as the authoritative store initially. Start with indexed search on names, breadcrumb text, and provider IDs, with bounded results and stable pagination. Benchmark before adding a separate search index; an index must carry the snapshot revision and remain rebuildable from PostgreSQL.

Proposed additions, subject to migration review:

- A taxonomy source identifies provider, environment, market/tree, locale, and applicable workspace ownership. Global reference data may be deduplicated only behind an explicit shared-data boundary; mappings and account data remain workspace-isolated.
- An import run records its scope, status, checkpoints, provider version, content hash, start/end times, counts, and failure details. Failed or cancelled runs cannot become active.
- A taxonomy snapshot and its nodes retain stable external IDs, parent IDs, names, paths, assignability, and retirement/replacement information. Preserve raw source payloads or immutable references to them as well as normalized fields.
- Requirement revisions retain the full provider document, normalized fields, content fingerprint, adapter version, provider version, and exact fetch context. Include account/seller, locale, requirements mode, and other parameters whenever they change meaning. Avoid nullable unique-key semantics accidentally permitting duplicates; use explicit normalized scope identities.
- An authoritative pointer publishes one complete taxonomy revision per source. Requirements may arrive independently, with explicit per-category readiness. Selecting a searchable category with missing requirements may create a draft, but cannot activate a production mapping until the required coverage is available.

Workers stage downloads, verify shape/checksum where supplied, validate duplicate IDs, parent links, cycles, coverage/counts, and provider constraints, then publish transactionally. Preserve the last usable snapshot on failure. Use a per-source lease/fencing token and ordered activation so a slower older run cannot overwrite a newer revision. Retry transient failures with bounded backoff and honor provider rate-limit responses. Resume work from durable checkpoints.

Keep hierarchy revision and requirements revision distinct: requirements can change without a category move. Compare canonical document content, not only provider version strings. A suspicious empty or sharply reduced download needs an explicit incomplete-import state; it must never erase the previous tree automatically.

Expose local search, children, exact-ID/breadcrumb lookup, requirements, and ingestion status through one service contract. Category/schema read endpoints return immediately from persisted data. A separate refresh command queues durable work. Missing data is reported as unavailable/preparing, never as an empty set of requirements or a successful search with no matches.

Retain full conditional semantics, units, cardinality, enumerations and value dependencies. The form renderer, formula validator, and publishing adapter must share the same requirement interpretation. Unsupported constraints produce a visible validation limitation instead of being silently discarded. A taxonomy attribute is not automatically a required field.

**Consistency across products**

Persist stable IDs; treat translated labels and paths as display data. Scope external IDs by their provider and tree/market. Do not propagate an eBay category ID to another market merely because the number matches. Amazon's browse node and product type must be validated together where applicable.

Preserve the resolver's explicit precedence and surface its provenance: listing override, primary category exact-market mapping, applicable wildcard, nearest mapped ancestor, other memberships, and the explicitly identified legacy Amazon fallback. Wildcards require verified applicability in each target market. Equal-priority conflicting targets remain unresolved. Store-level schema rules never cross account boundaries.

Every broad change creates a review against pinned taxonomy, requirements, mapping, and product/listing revisions. Scan every affected record in resumable chunks; the UI may show a paginated sample, but approval must use complete counts. Show changed assignments, newly required fields, incompatible values, preserved overrides, blocked records, and unchanged records. Include descendants when moving a category or changing an inherited assignment.

At activation, reject an obsolete review if any relevant input changed. Activate the reviewed mapping revision atomically and invalidate derived readiness. Use version checks to avoid overwriting concurrent operator edits. Keep old attribute values with provenance when a category changes; mark incompatible values for review instead of deleting or reinterpreting them silently.

Category changes save local drafts. Publishing is a separate action. Bulk publishing needs durable per-listing status, idempotency/reconciliation appropriate to the provider, bounded concurrency, retryable versus terminal failures, and visible partial completion. Do not equate queued, submitted, accepted, and live states. Rollback restores a local revision; reversing remote changes requires a separately tracked operation.

If a provider is temporarily unavailable, existing snapshots should still support browsing and draft editing. Missing, retired, conflicting, or materially stale requirements block affected publishing until resolved. Define freshness thresholds per provider and operation, and show the reason and last successful refresh. A zero-error marketplace guarantee is not achievable; the engineering objective is to prevent silent inconsistency, detect changes, and make failures visible and recoverable.

**Implementation order and measurable acceptance**

| Step | Deliverable | Acceptance evidence |
| --- | --- | --- |
| 1. Durable reference storage | Versioned snapshots, scope keys, import runs, active pointers, migration/backfill path. | Database tests for scope isolation, incomplete imports, duplicate jobs, out-of-order completion, and preservation of the prior snapshot after failure. |
| 2. Provider ingestion | eBay first as a complete hierarchy/aspect integration; Etsy next; Amazon product types/requirements and browse references separately; Shopify taxonomy and store definitions separately. | Recorded representative provider fixtures and authorized read-only integration checks; explicit coverage per source and schema context. |
| 3. Local read contract | Indexed search, breadcrumbs, requirements, readiness, and queued refresh. Switch existing pickers to this service. | No provider calls during ordinary picker/search/schema reads; restart resilience; correct missing/stale/error states; no cross-market results. |
| 4. Consistent activation | Extend existing impact reviews, tree/membership concurrency controls, and readiness invalidation. | Multi-connection database tests; changed schema/category/product revisions invalidate reviews; exactly one primary when memberships exist; removed categories cannot activate. |
| 5. Categories workspace | Dedicated page, product context links, existing formula workspace integration. | Read relevant Nexus component sources; use semantic tokens; mirror any shared DS changes in Factory, catalog/changelog, and DS-GAPS. Verify keyboard use, focus restoration, light/dark, narrow screens, loading/errors, and no-match states. |
| 6. Scale and rollout | Backfill connected scopes, compare old/new resolution, enable sources incrementally, observe jobs and publishing. | Load tests and production observation with no unresolved correctness differences; retain safe local rollback and visible coverage. |

Proposed load-test baseline: at least **100,000 taxonomy nodes in one source, 10,000 products, and 50 concurrent search clients**. Initial performance targets: local search API p95 below **150 ms**, cached requirement lookup p95 below **200 ms**, measured under that workload on documented hardware. Browser latency must be measured separately, including debounce and network time. These are proposed targets, not measured results. Test first-character and substring queries such as “suit,” exact IDs, diacritics, repeated names, long paths, and deterministic pagination.

Keep browser result sets bounded/virtualized and resolve schemas per distinct category/context rather than once per product. A job operating on thousands of products must expose progress, retries, and per-record failures. Include worker restarts, expired leases, provider throttling, partial downloads, simultaneous edits, and schema changes during an active review in failure testing.

Baseline verification completed before implementation:

```text
npm test --workspace @nexus/api -- \
  src/services/categories/schema-refresh.vitest.test.ts \
  src/services/categories/schema-etsy.vitest.test.ts \
  src/services/etsy/taxonomy.vitest.test.ts \
  src/services/pim/mapping/category-options.vitest.test.ts \
  src/services/pim/mapping/category-scope.vitest.test.ts \
  src/services/pim/mapping/impact.vitest.test.ts

6 test files passed; 37 tests passed.
```

These existing unit tests cover selected schema, taxonomy parsing, category-resolution, and review safeguards. They do not establish ingestion durability, concurrency correctness in PostgreSQL, UI accessibility, scale performance, or live provider acceptance. Implementation, type/token checks and browser verification were subsequently added; their results and scope are recorded in the linked implementation report.

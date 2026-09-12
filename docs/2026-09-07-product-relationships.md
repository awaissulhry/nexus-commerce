Product relationships in the Information grid use **Parent, Child and Standalone**, with P/C/S identity badges. Product role and Parent SKU appear together in a Product relationships column group on Shared product, Amazon and eBay. Existing saved layouts remain intact; choose All attributes or enable the columns in Customise to include them.

The role is derived from the existing catalog relationship: a product with parentId is a Child; a root marked isParent or with children is a Parent; another root is Standalone. No second writable role attribute or database migration was introduced. Alias projections reuse the same relationship. The legacy internal tree-band value `variant` is retained for compatibility and is separate from the displayed role.

Both columns are read-only in the grid. Enter, typing and double-click use the existing refusal guidance; it explains the calculated role or points to Catalog import & export for reviewed Parent SKU changes. The shared role calculation also supplies the family endpoint. The product header uses Child / Child of when viewing a child.

Parent SKU import behavior:

- Use Products field `parentSku`, SET, and the exact SKU as text. Numeric values and surrounding spaces are rejected; leading zeros are preserved.
- A new parent and its children can be created in the same file, independently of row order. An existing standalone must use the existing Promote to parent workflow before children can attach.
- An omitted or blank-action template field preserves the relationship. CLEAR unlinks; INHERIT retains the existing export-compatible unlink behavior.
- Product role is calculated and cannot be imported independently. Self-parenting, nested children, missing/archived parents and parents becoming children are refused by the relationship validation.
- Products with owned alias records or non-primary alias listing records cannot change Parent SKU through attribute import. Preview checks only products with an actual relationship change, using two batched reads; apply checks again inside the target transaction. Archived alias records are protected too.
- The template dictionary, workbook instructions and preview describe Parent SKU and use Child terminology. The Products template includes a blank-action Parent SKU row.

The completeness percentage still measures the original applicable attributes. The two relationship columns are added after completeness/readiness calculation and do not enter its denominator or marketplace validation. The grid uses existing family data to derive these fields without additional product reads.

Overlap found during read-only inspection of 338 active products: no inconsistent active parent flags, no custom parent/productRole attribute definitions, and one stored `categoryAttributes.parentage_level` value. That saved value was `parent` and inherited by children; it is marketplace metadata, not a reliable catalog relationship. Its Shared product heading is now **Saved Amazon parentage level**. Amazon scope uses **Amazon listing role**, **Amazon parent SKU** and **Amazon relationship type** for the existing marketplace fields. Stored keys, options, values and write addresses were preserved.

Verification on 2026-09-07:

- API relationship, import, heading and schema suites: 11 files, 193 passed, 1 skipped.
- Web Information grid and import preview suites: 35 files, 471 passed.
- Shared role cases: 5 passed. Shared package build and Web/API/Factory TypeScript checks passed.
- Tests include a real workbook/parser round trip with leading-zero SKUs, a reversed parent plus 101 children spanning preview pages, repeat apply without duplicates, and aliases appearing between preview and apply with no product write or audit record.
- DS conformance, raw-control ratchet and Web token guard passed. Generated Web and Factory token files are in sync. A shared DetailHeader layout fix prevents its metadata pills from overlapping autosave at 900px, with 14px measured clearance; its styles and documentation are mirrored in Factory.
- Browser: Shared product, Amazon and eBay display Parent/Child and the same parent SKU; relationship cells have no cascade actions. Enter on either relationship column opens no editor and gives the correct guidance. Light desktop, light/dark 900px and wrapped dark 600px presentation were inspected with no document overflow. The child header's parent link was checked. Saved layout dialogs were cancelled; theme and viewport were restored.

Verification boundaries: import execution tests use isolated test stores; live catalog inspection was read-only. No products, listings or saved layouts were migrated or published. The alias guard applies to catalog import preview/apply, not a rewrite of every legacy family-management endpoint; existing import jobs retain per-target transactions rather than whole-family rollback. Factory's token guard still fails on 54 existing platform-alias violations in its stylesheet (105 files scanned); the new header rule adds no token references. Live reference-name lookup limitations are documented separately in the reference-names report.

Lifecycle follow-up, 7 September:

- Information-grid Attach and Move now collect a named product with the standard Nexus searchable picker. Parent/Child/Standalone terminology and the existing role calculation remain unchanged. Cancellation performs no mutation.
- Attach, move, unlink, promote, demote, child creation/deletion and the legacy parent-delete route now validate current membership transactionally. Move/unlink accept the reviewed parent ID; forced demotion requires the exact reviewed children and detaches them atomically. Empty parents retain their Parent role until explicitly demoted.
- The shared alias guard now covers these family actions, including archived aliases and legacy alias foreign keys. Alias creation, rename and archive validate family/account ownership; archive retries are idempotent. New children and copied listing records remain drafts with publication/sync disabled. Local deletion refuses marketplace records; it is not a remote listing-takedown operation.
- The final follow-up API run passed 141 tests, including 31 disposable production-schema database cases, with one existing manual-fixture skip. The full Web suite passed 3,492 tests; the later focused family/action run passed 73 overlapping tests. Browser selection, confirmation, cancellation, focus, narrow light/dark layout and live deletion refusal were checked without applying catalog mutations. Types, build and current Web/Factory token checks passed; the historical Factory token failure above is closed.

Cache follow-up, 7 September: the audited family actions, child creation/deletion, alias creation and catalog import now update ProductReadCache inside their source transaction. Former and current parents refresh together, including counts, coverage and borrowed images. Production-schema SQL tests verify persistence and rollback when the cache update fails. Shared product and channel Information sheets also recover interrupted save acknowledgements and review Reload before discarding local edits.

The [cache and recovery evidence](./2026-09-07-product-cache-recovery.md) and [current product sign-off record](./2026-09-07-product-experience-signoff.md) contain the results and remaining boundaries. Other legacy bulk/provider paths, external search propagation, real multi-connection contention and navigation with pending edits remain broader work. The earlier alias-guard boundary above describes the initial import pass, not the expanded endpoint coverage in the lifecycle follow-up.

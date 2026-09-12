# Session 3 prompt — central mapping and bulk presentation management

Workspace: `/Users/awais/nexus-commerce` (or the coordinator's verified snapshot of its current uncommitted source).

Read `docs/catalog-redesign-sessions/README.md`, repository instructions, `docs/2026-09-06-catalog-workspace-redesign.md` and `handoff-01.md`. Start dependent implementation after session 1 explicitly hands off the account/write contract. Inspection can start earlier. Implement the task and verify it; do not produce another conceptual redesign.

The NEW `/channels/mapping` work in the current uncommitted tree is the canonical starting point. Preserve it, existing editors/services and the grid. Product editing alone has a secondary sidebar; eBay Presentation belongs there with contextual links to full reusable libraries. Standalone libraries/mapping and Products Next have no secondary sidebar. Use Nexus DS, semantic tokens and coordinated Factory/docs mirrors for changed UI.

**Owner clarification added while this session is active:** Read `PRODUCT-CONTEXT-ADDENDUM.md` now. Product-sidebar channel destinations must retain product context/sidebar and default to product-specific assignment/customization. Shared preset/theme/rule management remains explicit and broader. This supersedes earlier direct-to-library sidebar wording; coordinate shell/tab integration with Session 1.

## Objective and existing foundation

Make repeated mappings, defaults, theme assignments and buyer-facing variation order manageable centrally across explicit matching scopes, with product/listing exceptions. Existing field-rule/AutoMap impact reviews already scan bounded batches, use the canonical resolver before/after, preserve overrides and activate via mapping revision CAS. Theme versions, usage, a full editor, targeted updates and per-product variation ordering exist. Extend these rather than replacing them.

## Inspect and implement

1. Inspect `apps/web/src/app/channels/mapping`, `/channels/listing-presets`, current theme-library routes, product Studio `PresentationTab.tsx`, `products/ebay-flat-file/DescriptionStudio` and `VariationValueOrderModal.tsx`. Trace `pim-mapping.routes.ts`, `pim/mapping/*`, mapping revisions/resolution, category assignments, theme services and variation-order persistence.
2. Inventory actual rule scope/precedence and supported dimensions before adding fields: channel, account, market, shared family/category, marketplace category and matching criteria. Shared taxonomy and marketplace categories are distinct. Only expose dimensions that affect backend evaluation. Preserve explicit listing overrides and field-specific inheritance; do not invent universal precedence or rewrite shared facts for channel representations.
3. Complete reviewed activation for supported broad formula/category/clone changes that currently bypass it. Define deterministic supported overlap behavior; conflicting equal-priority rules must produce an explainable conflict or explicit resolution. Link effective-value sources to the supplying rule and show that shared-rule edits affect other products.
4. Distinguish stored shared-data correction, “Apply once to these records,” and “Keep applying this rule to matching records.” Extend current services for broad theme/preset/variation-rule assignment, including future eligibility where selected. Do not generate thousands of overrides to imitate a standing rule. Shared fact updates must use the existing shared writer.
5. Implement the reusable variation-order library/editor only through the existing ordering domain model, extending it where necessary. Reuse theme editor/preview and existing listing preset model. Show versions, usage, inherited/default versus explicit customization, and review affected listings. Keep grid sorting, shared variant creation, axis order and buyer-facing value order independent.
6. Product eBay Presentation must use the selected account/market/listing and the shared rule services for effective theme/order and overrides. Separate preview-product selection from listings explicitly selected for update. Saving/activating a library item must not silently publish; publication remains a separate reviewed operation with per-destination results.
7. Broad-change previews must report exact criteria, total products/listings, destination/language scopes, before/after values, preserved overrides, invalid/missing outputs, conflicts and exclusions. Provide full affected-set pagination. Bind activation to relevant rule/input/category/schema versions or an explicit stale-review policy; do not rely solely on mapping revision if other inputs changed.
8. Use bounded server queries, durable chunked jobs, retries and audit links. Recompute affected records when relevant inputs/rules/category membership change; preserve derivation and version provenance in caches/materialized values. Reuse current infrastructure and avoid catalog-wide reevaluation on page load/keystroke.

## Ownership

Own mapping UI/configuration/impact services, theme/ordering domain services and product Presentation, plus tests. The readiness handoff does not transfer core file ownership: coordinate any changes to account resolution, product writes or Studio contracts with Session 1. Do not edit catalog-transfer/imports or wizard/publishing workflows. Catalog selection entry points and shared Studio files require coordination with their owner. Schema, DS, registration and permissions follow the README single-writer rule; integrate needed patches before claiming completion.

## Verification and handoff

Use isolated data for thousands of products/variants, multiple accounts/markets, overlapping rules/categories, partial overrides, missing/invalid inputs, newly eligible products, stale previews, rule changes during edits, interruptions/retries and partial failures. Check browser rule → impact → activate and one-time assignment flows without publishing real listings. Verify product/grid/preview/import/publisher consumers agree on the same effective result; coordinate contract tests with sessions 1, 2 and 4 rather than copying resolution logic.

Run focused resolver, mapping, theme/order tests and type checks; verify scoped Presentation keyboard behavior, narrow light/dark UI and theme-editor draft/navigation protection. Record APIs, scope/precedence rules, changed files, actual checks, dependencies and honest remaining gaps in `handoff-03.md`.

## Current entry-point checks from Session 1

The latest accepted navigation supersedes the intermediate AMAZON/EBAY sidebar headings. The product sidebar contains product tasks; channel/account/market selection occurs once in the scope row. Presentation contains product-specific theme/order controls and explicit shared-library actions. Reusable library navigation belongs to the later main Channels phase. Retain distinct Listing presets, Description themes and Category & attribute mappings names. Product editing remains the only secondary-sidebar workspace. `CellFormula` still lacks account/alias coordinates; primary-only formula display and recalculation restrictions must stay until the real model and consumers support more scope. Listing override reset continues to use the canonical resolver.

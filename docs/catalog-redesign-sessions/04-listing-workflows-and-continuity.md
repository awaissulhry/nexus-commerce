# Session 4 prompt — listing lifecycle, jobs, issues and navigation continuity

Workspace: `/Users/awais/nexus-commerce` (or the coordinator's verified snapshot of its current uncommitted source).

**Current ownership update:** Do not start this as another writing session yet. The README's product-workspace follow-up transfers the bounded preset/wizard-draft work to the existing Session 02 and eBay presentation/order consumers to the existing Session 03. Shared destination/submission interfaces remain with Session 01. Those assignments take precedence over this prompt's original broad ownership; await their integration before the remaining listing-lifecycle implementation. Main Listings/Channels navigation remains a later phase.

Read `docs/catalog-redesign-sessions/README.md`, repository instructions, the implementation record and handoffs 01–03. Audit can start early; implement after those contracts/changes are integrated so this session connects one coherent workflow. Do not rebuild the grid or add secondary sidebars outside product editing. Use the Nexus design system and required semantic-token/Factory/docs process.

## Objective and existing foundation

Complete Create/import product → choose destinations → requirements → review → publish, both guided/resumable and direct/bulk, through the same domain services. Existing listing presets now have a central library, wizard picker, concrete review and guarded apply; queue feedback correctly distinguishes queued from complete. Some wizard/account paths, editors/links, issues/history and stale publishing protections remain incomplete.

## Inspect and implement

1. Trace `apps/web/src/app/listings`, `products/next`, `products/[id]/list-wizard`, relevant Studio readiness/issues/activity/deep links, `apps/api/src/routes/listing-wizard.routes.ts`, `wizard-templates.routes.ts`, listing/publishing routes and services under `services/listing-wizard`, synchronization and durable jobs. Inspect actual state/persistence models and ownership before changing behavior.
2. Carry explicit product/listing/channel/account/market coordinates and current versions from reviewed destinations into wizard/direct/bulk submission. Use the established resolver/validation and session 1 contracts. Preserve account-specific overrides, mapping-derived values and inventory/pricing owners. Finish legacy callers that omit review/write versions.
3. Keep draft save, validated review, queued submission, processing, success/failure and observed marketplace state distinct. Live listings can have unpublished changes or issues. Protect against stale jobs, including a rule/source/version change after review. Retry safely with per-destination outcomes and no duplicate submission effects. Explain partial completion; distributed publication is not atomic.
4. Beginners can resume the same product and chosen destinations. Experienced users select products/listings, review requirements and apply/publish in bulk using the same service operations. Preserve listing preset before/apply review and owned defaults. Do not replace working wizard steps with placeholders or leave an action that falsely reports completion.
5. Consolidate individual listing edits into the same product Studio with exact scope/listing/field coordinates. Reconcile remaining legacy editor links. Restore catalog filters, sorting, page and scroll on return. Deep-link issues into the appropriate cell/field without allowing stale asynchronous state to leak across scopes.
6. Reuse one authoritative issue model and coherent activity/job history with contextual filters, rather than maintaining duplicated status systems. Link jobs/results to their initiating import, rule, bulk action or publication where applicable. Preserve permissions and connected-account discovery; configured marketplaces alone do not imply connection.
7. Use server-side selection/filter queries, pagination and existing grid virtualization. Preserve advanced controls near grids. Avoid whole-catalog browser loads and arbitrary silent selection caps; surface supported limits explicitly while extending bounded background work where needed.

## Ownership

Own wizard/publishing/listings/continuity code and tests after prior handoffs. Coordinate Studio shell/readiness changes with session 1 owner and central mapping/presentation changes with session 3. Do not rewrite their implementations. Shared DS/schema/registrations/permissions remain coordinated single-writer files. Only one browser driver and one writer per build-output directory.

## Verification and handoff

Exercise guided and bulk paths with the same fixture inputs and compare validation/effective values. Test multiple accounts in one market, draft resume, preset apply conflicts, stale review/source/rule versions, submission racing newer edits, worker restart, rate limiting, partial failures and retries. Verify stale jobs cannot overwrite new work or claim marketplace confirmation prematurely.

Browser-check Products → edit → return continuity, listing/issue deep links, selection review, resumed wizard, keyboard navigation, narrow layouts and light/dark states. Use dry runs, mocked adapters or an isolated test environment; do not publish real listings or create mass working-catalog data. Run focused API/web tests and types. Record changed files, state-transition contracts, evidence, integration needs and remaining limitations in `handoff-04.md`.

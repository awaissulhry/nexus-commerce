# Session 02 follow-up — product listing presets and import verification

Workspace: `/Users/awais/nexus-commerce`. Continue the existing Session 02; preserve your original import implementation and handoff. This is authorized implementation, not another proposal. Read the coordination README, PRODUCT-CONTEXT-ADDENDUM.md, your handoff and the final coordinator integration receipt in handoff-01.md. Inspect the current dirty tree, applicable AGENTS.md, DESIGN.md and relevant design-system source before edits. The current source, including uncommitted work, is the baseline.

## Outcome and current evidence

Complete supported listing-preset selection/review/application for the product and destination shown in Studio, using the existing wizard/defaults consumer. Finish the outstanding isolated native-import verification if the browser prerequisite is available. Preserve the efficient grid and the completed imports. Product editing remains the only secondary-sidebar workspace; do not add channel branches or begin main Listings/Channels navigation.

The coordinator already applied and checked all three patches from `session-02-integration/`. Channel Import now opens catalog-transfer, channel exports are labeled review files, and legacy account-less channel previews/apply/revert are refused. Do not reapply those patches. Your original handoff's pending-patch section is historical.

Current `WizardTemplate` defaults contain reusable SKU strategy and variation settings. `reusablePresetDefaults` excludes product facts/identities; `fillPresetDefaults` fills absent keys and preserves explicit values. The current picker applies to a wizard, replaces its destination set after review, and describes primary-account limitations. `ChannelTuple`, wizard state keys and draft identity are channel+market based. None of that alone proves a preset can safely apply to the selected Studio account/listing. Inspect the actual consumers before extending the interaction.

## Implement

1. Record your start and exact owned files in `handoff-02.md`. Take copies before editing. Trace preset selection, draft creation/resume, supported defaults, effective consumers and existing CAS. Define the supported product/destination operation in that handoff early, with exact scope and write ownership. Keep shared SKU/variant creation under the shared model. Do not reinterpret a SKU-generation default as permission to rewrite existing SKUs or invent general listing-field assignments.
2. Reuse the existing preset library, defaults and review/apply services. Add a product-context feature surface for supported defaults, intended to mount within Information through coordinator integration. It must show product/family, channel, account, market and listing where they affect the operation. Shared preset management must be an explicitly broader action. A plain link into the global library is not completion of product application.
3. Applying from one product scope must retain that reviewed target. A preset containing other destinations must not silently replace them or create changes outside the chosen scope. Either project genuinely compatible defaults with exclusions visible in review, or refuse the incompatible preset. Preserve existing choices/overrides unless an explicitly supported reviewed action changes them. Explain whether the result changes a wizard draft or stored listing configuration; do not label a draft-only save as an updated listing.
4. Persist through the actual existing owner and validation path. Review binds the product, explicit destination, preset revision and target revision. Refuse stale review, changed account, inactive/foreign listing, wrong product or incompatible draft resume. Guard asynchronous preview/apply results across scope changes. A new account/alias must never collapse into the primary account through the old wizard tuple/hash. Propose exact shared-contract patches where needed; do not create another resolver or preset store to bypass this constraint.
5. Keep “Apply once” distinct from a standing rule and preserve the reusable definition. Publication is separate. Do not add unsupported broad/standing preset assignment or claim it is finished. If the supported defaults require wizard consumer changes, complete their persistence and consumption within this assignment; coordinate shared interfaces before exposing the control.
6. Revisit the native upload check using your isolated fixture, never the working catalog. HTTP multipart and URL-input browser checks are already recorded; they are not substitutes for the chooser. Do not alter browser/extension security permissions silently. If the prerequisite is still unavailable, record it precisely, release the browser promptly and continue presets. Respect tool-specific browser instructions and any required approval.

## File ownership for this follow-up

In addition to your existing import files, you may directly edit:

- Web `apps/web/src/app/channels/listing-presets/` and related focused tests. This transfers the preset-library area from the original Session 03 allocation.
- New product preset feature files under `apps/web/src/app/products/[id]/edit/_studio/presets/`. Send mounting changes as coordinator patches; do not edit `ChannelSheet.tsx`, `SheetToolbar.tsx` or Studio shell/scope files.
- Web `apps/web/src/app/products/[id]/list-wizard/`, limited to draft/preset/selection behavior needed here. Preserve unrelated steps and recent edits.
- API `apps/api/src/routes/wizard-templates.routes.ts`, `listing-wizard.routes.ts` and their tests; edits to the latter are limited to product/draft/preset/read contracts, with existing submission behavior preserved pending shared integration.
- API `apps/api/src/services/listing-wizard/preset-defaults.ts`, its tests and new focused preset/draft service modules.

Do not directly edit `services/listing-wizard/{channels,submission.service,channel-publish.service}.ts`, any publishing adapter, eBay cockpit/presentation/mapping files, core writers, shared packages, DS, Prisma, registration, permissions or lockfiles. These shared interfaces need a patch for the coordinator; eBay consumers belong to Session 03. Record patch baseline hashes and the required contract in your handoff early so Session 03 can consume the agreed interface without competing edits. Reread current source before preparing final patches.

## Verification and delivery

Use isolated fixtures with two products/families, two accounts in one market, another market and aliases. Exercise compatible/incompatible presets, preserved explicit defaults including blank/null/false, stale preset/target revisions, account changes while previewing, retry/resume and wrong-product targeting. Assert that the other product/destinations and reusable definition are unchanged, and that configured defaults reach the real consumer. No real publication or bulk fixtures in the working catalog.

Run meaningful API/Web tests, types, token/conformance checks for changed UI, and browser keyboard/responsive light/dark checks for selection, review, cancel and apply. Record the exact observed outcome, not just a successful request. Preserve advanced grid behavior; do not change the grid engine. Shared DS gaps require coordinator integration, exports/docs/changelog/DS-GAPS and the Factory mirror.

Append a dated follow-up receipt to `handoff-02.md`: changed paths, scope/persistence contract, fresh tests/logs, browser lease/result, remaining limits and exact coordinator patches. Distinguish implementation ready for integration from integrated and verified. Do not edit Session 01/03 handoffs or the coordination README. The native-upload prerequisite must not cause unrelated preset work to stop.

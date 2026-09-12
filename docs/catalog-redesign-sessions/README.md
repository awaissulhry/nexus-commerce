# Catalog redesign: session coordination

Prepared 2026-09-06 from the current working tree. These are implementation tasks, not claims of completion. Read `../2026-09-06-catalog-workspace-redesign.md` for verified foundations and remaining limitations; inspect source because the tree is changing.

**Latest accepted navigation:** Read [PRODUCT-CONTEXT-ADDENDUM.md](PRODUCT-CONTEXT-ADDENDUM.md). The product sidebar contains work for the selected product; channel/account/market selection occurs once in the scope row. The latest owner revision restores Amazon/eBay branches without mappings. eBay has separate Description themes and Variation order pages; Amazon/eBay Listing information links use the existing product sheet. Complete Products and product editing before the main Listings and Channels navigation phase. Shared libraries remain explicit contextual actions and will be organized under main Channels navigation, using existing routes/services.

## Current assignments — product-workspace follow-up

The owner has authorized the coordinator to lead the two existing Sessions 02 and 03. **These assignments supersede the older ownership table below for this increment.** Original prompts and handoffs remain useful history. Both previous feature handoffs have been inspected; all three Session 02 integration patches and Session 03's source-metadata patch are applied and verified in the final integration receipt in [handoff-01.md](handoff-01.md). Do not reapply those patches from their old baselines.

| Owner | Current assignment | Status at assignment |
| --- | --- | --- |
| Session 01, this coordinating session | Studio shell, scope/write contracts, exact listing deep links, shared-file integration and combined verification | Owns integration; no full product-phase clearance |
| Existing Session 02 | [Product listing presets and import verification](02-product-presets-followup.md) | Assigned; requires the user to relay the follow-up to the existing chat |
| Existing Session 03 | [Product-specific eBay Presentation completion](03-product-presentation-followup.md) | Assigned; requires the user to relay the follow-up to the existing chat |
| Sessions 04/05 | Remaining listing lifecycle and final integrated quality/scale gates | Do not start another feature writer or the main Listings/Channels navigation phase |

Session 02 now owns the listing-preset library/picker/defaults and wizard draft/preset integration specified in its follow-up, in addition to its import files. This explicitly transfers that bounded work from the original Sessions 03/04 allocation. Session 03 owns the specified eBay presentation/order consumers, including the eBay publishing adapter, transferred from the original Session 04 allocation. Session 02 must not edit those eBay consumers; Session 03 must not edit listing-preset or wizard draft files. Shared wizard destination helpers, submission orchestration and core Studio files remain coordinator-owned; each follow-up lists these boundaries. File ownership applies to the whole file, even when only one section needs changing.

Only the coordinator edits this README, the addendum and shared integration records. Each feature session appends its new status, changed files, interface needs and evidence to its own handoff, preserving historical evidence. The coordinator reviews current source and runs combined checks before recording clearance. A finished chat or a passing isolated suite is not integration clearance.

These are separate chats, not directly addressable agents. Shared files do not wake an idle session. The user must paste the follow-up once into each existing chat and notify the coordinator here when a contract patch or final handoff is ready. Do not claim an assignment has started until that session records its start.

Browser coordination for this round: all previous leases are released. Session 02 has the first turn for its isolated import check; it records acquisition and explicit release (or skip with reason) in `handoff-02.md`. Session 03 continues implementation/API tests until that release and then records its own lease in `handoff-03.md`. The coordinator stays out of the browser until both release it. If a newer recorded lease already exists, respect it. Use separate available ports and build outputs; the previous Session 02 fixture used 3102/4102 and `.next-session-two-test`. Session 03 may use 3103/4103 and `.next-session-three-test` only after checking availability. Do not claim or restart another session's process.

## Original sequence (historical allocation; current assignments above take precedence)

| Session | Work | When to start implementation |
| --- | --- | --- |
| [1](01-account-and-write-contracts.md) | Account scope and shared write contracts | Current coordinating session; do not start a second writer for this task |
| [2](02-unified-imports.md) | Unified imports, presets and source ownership | After session 1 records the usable account/write contract and passes its focused checks |
| [3](03-central-mapping-and-presentation.md) | Central mapping, themes and variation-order management | Alongside session 2, after the same contract handoff |
| [4](04-listing-workflows-and-continuity.md) | Guided/bulk listing, jobs, issues and navigation continuity | After sessions 2 and 3 are integrated, to test one coherent workflow |
| [5](05-integrated-quality-and-scale.md) | Accessibility, browser, scale and release verification | Read-only baseline audit can start now; final verification and fixes follow integration |

The core contract handoff is now available in [handoff-01.md](handoff-01.md), with focused test evidence and explicit consumer restrictions. Sessions 2 and 3 may begin implementation against that current source.

Use at most two feature-writing sessions concurrently. Keep this session as the integration owner. Sessions 2 and 3 can inspect and write their own audit notes before the contract handoff, but must not guess unresolved account/write behavior. Session 4 can audit publishing during that interval. There is no automated scheduler or readiness flag here: the coordinator must explicitly record the handoff, evidence and any remaining restrictions.

## Shared working-tree rules

- The tree has hundreds of existing modified/untracked files, including important new mapping/grid work. A worktree from Git HEAD alone is **not** an adequate baseline. Use separate worktrees only after the coordinator prepares and verifies a faithful source snapshot including relevant uncommitted and untracked work. Do not blanket-commit unrelated work to manufacture that snapshot.
- If sessions use this same workspace, enforce distinct file ownership. No simultaneous edits to one file, including different sections. Before touching an owned file, save its current content and reread it immediately before applying a small patch. Do not reset, stash, clean, check out older versions, or format whole directories.
- Session 1 retains ownership of connection resolution, core product writes, Studio account/scope contracts and `product-studio.routes.ts`, including after the readiness handoff. Readiness permits consumers to use the contract; it does not transfer ownership of core files. Session 2 owns catalog-transfer and source-import modules. Session 3 owns mapping configuration/impact and eBay presentation libraries. Session 4 owns wizard, publication, listings and catalog continuity after handoff. Session 5 owns verification artifacts and coordinates fixes with the feature owner.
- Shared design-system files, Prisma schema/migrations, shared package exports, API registration, permission manifests, lockfiles and the main implementation record have one writer at a time: the coordinator. A feature session may prepare an exact patch against the current file; the coordinator applies and verifies it before the feature is declared complete. Do not leave unregistered code described as wired.
- Session-specific handoffs live beside these prompts as `handoff-01.md` through `handoff-05.md`. Do not create or edit another session's handoff. Each includes changed files, contracts, actual tests/results, unresolved dependencies, limitations and steps for integration. Write readiness explicitly; do not infer it from the file existing.
- Only one session controls the shared browser at a time. Agree on separate dev ports/build-output directories for independent runs. Do not restart another session's servers, regenerate shared outputs concurrently, or run live-data scripts as tests.

## Launch boundary after Session 1

Sessions 2 and 3 are cleared to start against the current shared workspace after reading the latest addition to `handoff-01.md`. Do not launch a second Session 1. Keep Session 4 implementation waiting for both consumer handoffs and integration; Session 5 may audit read-only now.

| Owner | Directly editable feature area | Files to send back as integration patches |
| --- | --- | --- |
| Session 2 | Catalog-transfer/source-import UI, import services/jobs/routes and their focused tests | Core product/Studio routes and writers; shared package contracts/exports; schema; DS; registration/permissions; lockfiles |
| Session 3 | Canonical mapping configuration/impact; theme/order/preset libraries and domain services; `PresentationTab.tsx` and its feature modules; focused tests | Core product/Studio routes and writers; Studio scope/save contracts and `ChannelSheet.tsx`; shared package contracts/exports; schema; DS; registration/permissions; lockfiles |
| Session 1 coordinator | Core account/write/read/save contracts, shell and shared integration files | Consumer implementation remains with its session until that session hands it back |

In particular, `services/connection-resolver.service.ts`, `services/pim/{product-category-context.ts,studio-sheet.service.ts,scope-readiness.service.ts,listing-alias.service.ts,channel-value-write.ts}`, `routes/{products.routes.ts,product-studio.routes.ts}`, Studio `contracts.tsx`, `types.ts`, `StudioClient.tsx`, `StudioSubheader.tsx`, `StudioBar.tsx`, `StudioTabHost.tsx`, `saveState.ts`, and `sheet/channel/{ChannelSheet.tsx,ChannelScopeTab.tsx,useChannelSheet.ts,rows.ts}` remain coordinator-owned. Coordinate their focused test files too. A feature session should implement its independent feature work and place exact required shared-file changes in its handoff for integration, without describing that pending integration as complete.

The coordinator has finished the browser smoke check and releases the shared browser. Before browser work, record which session is using it in that session's handoff; if the other session is using it, continue independent implementation/tests until it is released. Do not restart the existing Web/API servers. New test environments must use separate available ports and isolated build outputs, with no live-data fixtures.

## Requirements that apply to every session

The latest navigation decision supersedes the original catalog-sidebar proposal: **only `/products/[id]/edit` has secondary navigation**. `/products/next` and standalone libraries have none. Product editing provides Information, Media, eBay Description themes, eBay Variation order, Needs attention, Performance and Activity. Variant editing remains in the existing Information family grid; a dedicated Variants destination must reuse that owner and is not wired by this navigation increment. Channel branches provide shortcuts to existing product tasks; the scope row remains the account/market control. The latest revision restores Amazon/eBay branches without mappings. Explicitly labeled shared-library actions access broader reusable management. See PRODUCT-CONTEXT-ADDENDUM.md for scope semantics and pending integration. Product eBay Presentation gives contextual access to reusable libraries; central configuration must still support broad management without opening each product.

Preserve the shared Nexus grid engine and current editing infrastructure. Read `AGENTS.md`, applicable nested instructions, `DESIGN.md` and relevant design-system component source before UI changes. Use `apps/web/src/design-system`, semantic `--nds-*` tokens and layout-only feature CSS. Missing reusable controls belong in the design system with exports, catalog/changelog/DS-GAPS updates and a careful Factory mirror. Coordinate shared-file changes as above.

Use the actual `/channels/mapping` implementation and existing domain operations. Keep shared facts, transformations, scoped overrides, presentation defaults, inventory, pricing and marketplace state under their declared owners. Saving is distinct from submission, processing and confirmed marketplace state. Never publish real listings or write scale fixtures into the working catalog.

Test the behavior changed, including failure and stale-response paths. Inspect package scripts before running checks. Known evidence and pre-existing failures are documented in the implementation record; rerun appropriate checks for the current snapshot and report unrelated failures separately. An old passing log is not verification of new code. Do not declare partially connected workflows complete.

## Launching a session

Open the same verified source baseline and paste: “Read `docs/catalog-redesign-sessions/0N-…md` and its coordination README, then execute that implementation task. Respect the start dependency and file ownership. Inspect first, implement within the authorized scope, verify, and write the specified handoff.” The individual files below contain the complete task instructions.

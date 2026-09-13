PR.1 progress and measured limits — 2026-09-13

This is an interim lane record, **not** W2-READ, W3-API or AT-WAVE-4. W0-SEC, W0-GATES and W2-READ-SHAPE were posted earlier in the ledger. Nothing is committed; PR.1 made no production or channel write.

| Brief items | Current result |
| --- | --- |
| 1–5, 8: security, actor, Etsy retirement, Matrix retirement, recovery | W0-SEC DONE. Existing-vocabulary guards, real request actor, scoped Matrix update and named route/method retirements measured; exact guard choices and external actor requests in ledger. |
| 6: gate repair and original baseline | W0-GATES DONE. Selector-list swatch parser, red scratch control, and immutable instrument readings in [baseline](../baseline/README.md). |
| 7: contentAddress/restore | LX had already moved the source requirement; four actual-service/restore regression controls passed, with the old branch convicted in scratch. |
| 9: wire shapes | [Wire document](../../../pr-presence-wire.md), canonical type-only imports in services/presence/types.ts. W2-READ-SHAPE DONE; PR.7 consumed it. |
| 10: full Presence reads | Waiting for W2-SCHEMA-APPLIED. No new Presence column queried or invented backfill. |
| 11: verification | Parser, durable 60-attempt workspace/hour counter, 10-coordinate call cap and Amazon account serialization tested. HTTP read adapters, fact persistence, worker/enqueue hook and GALE live-channel read-back are pending the schema gate. No READY enqueue export claimed. |
| 12: projections | Existing offerClosedAt/By/Reason/syncPaused and offerActiveHonoured plus queue source coverage delivered. Full Presence product/participation/connection projection and channelFactDetail remain pending. |
| 13: operational impact | Implemented, guarded, tested and read against local GALE. Legacy GET preserves its four arrays and original predicates/error arms; stock/ads failures are advisory. |
| 14–18: complete read gate, local verbs, recreate/axis gates | Still outstanding. They require the full schema/read gates and the cross-lane integration. |

The latest focused API run passes **108 tests in seven files**, using mocked Prisma and a fetch stub installed before import. API TypeScript exits **0**. Two additional regressions proved that the impact source must retain unsent FBA offers and distinguish stock evidence from a declared fulfilment method (2 red + 37 controls before repair). An overlapping-market inventory regression also convicted an unjustified pooled quantity (1 red + 12 controls); overlap now reports unknown quantity. The nine previously failing studio tests gained the required Marketplace.findUnique fixture method; all their account/provenance assertions remain.

| Instrument | Exact command (repository root unless stated) | Exit / evidence |
| --- | --- | --- |
| API types | `npx tsc --noEmit -p apps/api/tsconfig.json --tsBuildInfoFile /private/tmp/nexus-pr1-presence/api-w2.tsbuildinfo` | 0; [log](api-final.log), [exit](api-final.exit) |
| Focused API | From apps/api: `npx vitest run src/routes/presence-guards.vitest.test.ts src/lib/auth/permissions-manifest-order.vitest.test.ts src/services/products/operational-impact.service.vitest.test.ts src/services/presence/fba-posture.vitest.test.ts src/services/presence/verify-budget.service.vitest.test.ts src/services/pim/studio-account-resolution.vitest.test.ts src/services/pim/studio-channel-provenance.vitest.test.ts --maxWorkers=2` | 108/108; [log](w2-final-focused.log), [exit](w2-final-focused.exit); load3.41 before runs |
| Local route read | From apps/api: `PR1_LOCAL_IMPACT=1 npx vitest run src/services/products/impact.local.vitest.test.ts --maxWorkers=1` | [actual DB receipt](operational-impact-local.json), [log](impact-local.log), [exit](impact-local.exit) |
| RBAC coverage | `npx tsx apps/api/src/scripts/check-rbac-coverage.ts` | 0; 2687 routes,88 permissions,71 PUBLIC,0 UNMAPPED; [log](rbac-w2.log), [exit](rbac-w2.exit) |
| Swatch | `node scripts/check-grid-swatch-contrast.mjs` | 0; [log](swatch-final.log), [exit](swatch-final.exit) |
| Route Prisma | `node scripts/check-route-prisma-ratchet.mjs` | 0; [log](route-prisma-final.log), [exit](route-prisma-final.exit) |
| Full API | From apps/api: `npx vitest run --maxWorkers=2` | Red; [log](api-all.log), [exit](api-all.exit), [failure groups](api-failure-groups.json). Previous reading preserved in api-all-before.log. |

Every exit file is populated by shell redirect after the command, not a pipeline exit. API tests print **127.0.0.1:55439/nexus_development**, the local Docker database. The local impact test asserts GALE Product.version and updatedAt unchanged and makes zero outbound requests. The latest full-suite reading is **724 files: 693 passed,25 failed,6 skipped; 8728 passed/197 failed/28 skipped tests (8953 total)**, exit1,93.44s. The original206-failure reading is preserved separately; nine fixture failures are now resolved. Neither reading is called a baseline or green gate. Remaining failures were sent to PR.4 and the Owner/LX successor with exact paths and reasons. No old assertions or ratchet ceilings were removed to clear them.

Outstanding dependencies and decisions:

- PR.5 applied the additive schema locally and measured 68/68, but W2-SCHEMA-APPLIED requires both databases. The additional production prerequisite includes existing-record workspace assignment and index/RLS changes, and is held on the Owner's separate scope decision. See the [reviewed prerequisite](../measurements/prerequisite-review.md). PR.1 cannot apply it or declare a replacement gate.
- PR.4 owns the approved whole-module Presence runtime move; PR.6 has released its exact paired source/declaration hunks. No duplicate runtime table or unapproved shared-file edit is introduced by PR.1.
- PR.2 waits for the actual verify worker/enqueue pair. The reviewed captured target is `{coordinate, externalListingId, sellerSku, listingId?, sourceQueueId?}`; direct callers need no queue ID. Missing verified actor/workspace yields an explicit enqueue refusal. A deleted local mirror cannot establish remote absence.
- Alias action IDs are `archive-alias`/`restore-alias`. Verify's reach is `channel` because it reads there; its permission is products.view and reversal is null. Consumers use server availability rather than infer write permission from reach.
- External default-user sites and full API failures outside this lane remain individual ledger REQUESTs. The original ledger remains the complete ownership/assumption/request record.

The browser-hold overlap from the API helper/test saves at18:56–18:58Z was disclosed with mtimes; affected readings were qualified and rerun by their owners. Subsequent saves use the full anchored STARTING/FINISHED history before writing. Shared catalog saves announced their first hunk and re-read PR.2's transaction announcements; the PR.2 cascade block was not replaced.

Latest actual GALE read at 2026-09-13T19:21:07.191Z, on 127.0.0.1:55439/nexus_development: GET preflight 49.7ms, coordinate POST 41.12ms, product POST 32.1ms; all HTTP200, version59 and updatedAt unchanged, outbound0.

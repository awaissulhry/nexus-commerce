# PR.3 — Presence narrowing and offer services

PR.3 AT-WAVE-4 posted. All requested PR.3 work is measured; no commits, production writes or channel writes. Programme-wide W1.5-PUSH remains reopened by PR.4 and is not claimed green here.

## W1-COORD

`apps/api/src/lib/listing-coordinate.ts` exports `ListingCoordinate`, `whereCoordinate` and `ListingCoordinateError`. The helper preserves all five fields; omitted/undefined fields refuse with `LISTING_COORDINATE_MISSING_LEVEL`; invalid NULL/blank fields refuse with `LISTING_COORDINATE_INVALID_LEVEL`. `channelConnectionId:null` explicitly selects SQL NULL. `aliasKey:''` is a stated primary alias, not a default.

Local DB: `127.0.0.1:55439/nexus_development`; server reports `nexus_development`; Prisma runtime role `nexus_workspace_runtime`. GALE-JACKET version 59. The measured schema has nullable `aliasId` and `channelConnectionId`, NOT NULL `aliasKey` and `marketplace`. Legacy account unique indexes are NULLS NOT DISTINCT and still prohibit same-account aliases; alias-key indexes are ordinary UNIQUE. The old proposal comment about NULL aliases refers to `aliasId`.

Command (from apps/api): `PR3_LOCAL_DB_TESTS=1 ../../node_modules/.bin/vitest run src/lib/listing-coordinate.vitest.test.ts src/lib/listing-coordinate.local.vitest.test.ts`. Exit 0; 2 files / 16 tests passed. See coordinate-tests.log. Five missing-field tests each cover omitted and explicit undefined; four forbidden NULL fields; all-five-fields output; permitted NULL account; four blank-field refusals. The local test asserts two rows, one NULL account match, one attributed control, one changed row, unchanged sibling after eight seconds, wrong-alias zero/right-alias one, exercised rollback and zero sentinel residue in both tables. Initial attempted fixture on GALE hit its existing account unique constraint; the successful fixture used a disposable DRAFT product in the verified XAVIA family.

## W1.4 site table (source content anchors)

Every local case starts with two DRAFT rows sharing product/channel/market, differing account and alias. External IDs are fake sentinel values. Each write is followed by an eight-second read-back; cleanup is by sentinel value, with zero residue assertions. `listing-coordinate-sites.local.vitest.test.ts` runs the actual service/route logic with transport, queue and append-only journal seams mocked.

| File / content anchor | Before-shape | After-shape | Local test / result |
|---|---|---|---|
| ebay-flat-file-delete.service.ts / handleRemoveChannelListing | parent+child product IDs, EBAY, market for loader/deleteMany | Same OR of enumerated whereCoordinate calls; captured identities only; Guard2 after deletion; market exclusion skipped when another account/alias survives | remove1, sibling1; file-exclusion count0 |
| amazon/amazon-flat-file-remove.service.ts / listings capture + transaction deleteMany | parent+child product IDs, AMAZON, market | Identical five-level OR in both; full seller/account capture; named fanOut and actor event | old predicate count2; removed1, sibling1; fanOut names target. Separate unit test enumerates parent+child |
| amazon-market-offer.service.ts / loadRow + close/reopen update | findFirst(product, AMAZON, market), then ID write | Same helper plus captured ID on writes | dry-run changes0; ack closes1 with offerActive:false; sibling stays open |
| sync-control.routes.ts / PAUSE-RESUME-ZERO_PIN loader | OR of three-field targets | OR of whereCoordinate; selected rows retain all five; writes repeat helper and ID | ZERO_PIN changes1, sibling quantity5; FBA product/AMAZON_* evidence refuses the push |
| sync-control.routes.ts + follow-master.service.ts / FOLLOW delegate | productIds × markets loader | Explicit coordinates forwarded; helper in initial/fresh reads and per-row update | FOLLOW changes1, sibling quantity5/overrideNULL |
| marketplaces.routes.ts / PATCH offer-availability | primary-account compound upsert, aliasKey hardcoded empty | Validated request coordinates → service serializable plain pre-read + exact update/create | offerActive false on1; sibling true |
| marketplaces.routes.ts / POST bulk-offer-availability | primary-account compound upserts; broad activated-ID reload | Explicit pairs through same service; activation receives only returned IDs | offerActive false on1; sibling true |
| listings/recovery.service.ts / preview loader + execute updateMany | three-field findFirst/updateMany | Same full helper in both; dry-run delete refuses further lifecycle work | target ASIN cleared/ENDED; sibling fake ID/DRAFT unchanged |
| ebay-label-guard.service.ts / Lane A/B identity backfill | product + (market OR region), external ID NULL | Membership owning account; unambiguous stored alias; helper on pre-read/write; terminal refusal | target linked1, sibling NULL; ended target later linked0 |
| listing-reconciliation.service.ts / confirmReconRow | primary account, alias empty upsert; ACTIVE unconditional | Request coordinate checked against recon row; nullable-safe pre-read/write/create; terminal refusal | target DRAFT→ACTIVE; sibling DRAFT; ENDED target subsequently refused |
| amazon/flat-file.service.ts / delProducts ENDED/isPublished/snapshot stamp (PR.4) | product/AMAZON/mp | PR.4 paired full metadata/helper loader + write, preserves snapshot | PR.4 W1.6-GATE:26/26 mocked tests incl explicit NULL and missing-level refusals; not claimed as PR.3 local-DB measurement |

The broader family/member enumeration is a read. Every mutation uses the stored named coordinate. A member group without an account or with ambiguous aliases does not backfill. Legacy same-account alias creation remains constrained by the existing indexes; that limitation is exposed, not repaired here.

## D24 decision and implementation

Choose a named payload refusal for missing fulfilment, not omission: variation-sync-processor currently defaults omitted item.fulfillmentChannel to DEFAULT. Amazon requirements are conditional on product type, seller and store; there is no globally optional fulfilment claim justified by the docs. Sources read: [Product type definition](https://developer-docs.amazon.com/sp-api/docs/retrieve-a-product-type-definition), [Listing guide](https://developer-docs.amazon.com/sp-api/docs/manage-product-listings-guide). No channel request was made.

## Final verification

One completed final run began **2026-09-13 19:36:28 Europe/Rome** from `apps/api` against **127.0.0.1:55439/nexus_development**. Host identity was printed before the checks; all three launches were below load8. The preceding load75 deferrals launched no tests and are not substituted for this run.

| Check | Result |
|---|---|
| API tsc, private build-info | exit0, no diagnostics |
| API Vitest, two workers | **174/174 passed,13 files,exit0,125.37s** |
| Actual local database cases | **13 passed**: one NULL helper fixture +12 service/route/FBA cases |
| Canonical FBA | offer close/reopen controls, existing outbound tests, local ZERO_PIN product-FBA and stored-AMAZON_EU cases all pass |
| Label-repair direct push guard |9/9 passed; old-source probe8 failures +1 unlocked positive control |
| GB/UK private variation removal through public caller | both arms pass; full16-test market file is included in174 |
| GET all-listings explicit products.view guard | denied arms make no listing read; authorized grouped response unchanged |
| Route-Prisma ratchet | exit1; **three dirty files outside PR.3**: assets62→64, brand-story32→33,catalog-transfer0→2 |

No ratchet baseline was raised. The own marketplaces increase was removed by moving the coordinate writer to a service; PR.2 also removed its delist-cascade increase. Final route output is `api-final-route-prisma.log`. Detailed assertions, host, fixtures and cleanup are in `api-final-vitest.log`; machine-readable result is `final.json`. `run-final.sh` contains the exact executed commands. `before.json`, `after.json`, `additional-files.json` and `owned-source.diff` distinguish this lane from pre-existing uncommitted work; PR.1 retains ownership of its explicitly handed-off route hunks.

Rehearsal: two DRAFT XAVIA rows with fake external IDs, same product/AMAZON/IT and different account/alias. The old three-level predicate counted2 and was never used to delete. The actual narrowed service removed1 and named it in fanOut; the sibling survived the eight-second read-back. Sentinel listing and product residue both0. The local test suite asserts global fetch count0 and mocks queue/journal boundaries. No pre-existing Product or inventory was changed.

The initial helper gate16/16 and intermediate49/49,45/45,148/148,173/173 readings remain historical evidence. The final174-test reading supersedes them. Optional presenceIntent cases use mocks because the physical Wave2 schema is not yet declared; the legacy ENDED refusal is proven on local PostgreSQL.

## Additional label-repair guard

PR.4 identified a direct label revise after the initial terminal-only checks. The owning-account/market/ItemID control read now requires at least one row, validates every complete coordinate, and calls the shared assertPushAllowed for every row before token acquisition or Trading calls. Missing/failed controls and legacy ENDED rows refuse explicitly. The summary retains each refusal code and sentence.

A scratch test against the old source produced **8 failed / 1 passed**, exit1: all eight lock/unavailable cases reached both mocked Trading operations; the unlocked positive control worked. No working-tree source or test was rewritten for this old-source probe. The final nine tests add explicit returned-refusal and account-scope assertions. See label-lock-red.log. HELD/WITHDRAWN fields are mocked pending the Wave2 physical schema; syncPaused/offerClosedAt already exist.

## Assumptions and handoffs

- ASSUMED (measured correction): only an explicitly supplied NULL account is permitted. `aliasKey:null` is invalid because both databases require it; `aliasId` is the nullable legacy field. Current M3 rows are all account-nonnull/alias-empty. Tests encode local AMAZON731/EBAY277/ETSY2/SHOPIFY2 and prod AMAZON725/EBAY252.
- ASSUMED (fixture constraint): the legacy account indexes prevent two same-account aliases. Two disposable DRAFT rows therefore differ in both account (existing vs NULL) and sentinel alias. Their shared product/channel/market still proves the old three-level query would select both. No index was changed.
- ASSUMED (W1 boundary): local removal still commits before best-effort channel orchestration. Captured seller SKU/account/alias and named refusal/dry-run outcomes improve its honesty; durable acknowledgement sequencing and Amazon resurrection resolvers remain Wave 4 work. No real channel operation was executed.
- ASSUMED (FOLLOW compatibility): the additive coordinate option is mandatory for the narrowed Sync Control callers. Unrelated legacy callers retain their existing explicit product/market behaviour. The EU guard groups enumerated targets by product/account/alias and preserves the existing consent requirement.
- ASSUMED (terminal compatibility): physical presenceIntent/endedAt columns are not available before Wave 2. The label guard conservatively skips all legacy ENDED rows, including those with isPublished=false and offerActive=false. Optional terminal-intent checks activate on full model reads after schema generation. No missing-column SELECT is issued.
- REQUEST TO PR.4 — full helper call at the `delProducts` loop's ENDED/isPublished/snapshot update, paired with its loader; fulfilled by PR.4 W1.6-GATE. The early guessed `if (action === 'delete')` anchor was explicitly superseded by this content anchor. Editors and parser untouched.
- REQUEST TO PR.4 — agreed: only real acknowledged close pairs offerClosedAt with offerActive:false; only acknowledged reopen clears closure and sets offerActive:true. A stale submit must retain skip_offer. Fulfilled in both services and PR.4's flat-file consumer.
- REQUEST TO PR.1 — prepared account/alias/actor route pair applied in the same write operation as services. PR.1 reports53/53 route/actor checks; session actor wins over forged body actor. Amazon ProductEvent carries full data.coordinate and named fanOut. Audit/event boundaries are mocked in fixture tests to avoid append-only residue.
- REQUEST TO PR.1 — recreate guard path/signature: `services/presence/recreate-guard.ts`, `assertRecreateAllowed(coordinate,{override?})`. Not yet available. Reconciliation refuses RECON_RECREATE_REQUIRED for ENDED/terminal rows until that guard lands. The new identity table and full recreate flow could not be tested before the schema gate.
- REQUEST TO PR.1 — additional products.view guard on GET all-listings applied without changing its grouped response; guard injection test included in final run.
- REQUEST TO PR.5 — measure aliasId vs aliasKey and both index generations; fulfilled by M3 follow-up. Local akey indexes are ordinary UNIQUE with workspaceId; production akey indexes are NULLS NOT DISTINCT without workspaceId. Do not relay local DDL as production DDL.
- REQUEST TO PR.2 — canonical FBA predicate import/re-export on outbound-sync; applied and witnessed. One implementation preserves listing/product FBA, AMAZON_* platform attributes, positive FBA stock and active FBA Offer evidence. Existing outbound FBA tests included in final run.
- REQUEST TO PR.2 — delist-cascade route ratchet 0→4 attributed to its lane; extraction requested and fulfilled. Final guard no longer lists that file; PR.3 did not edit it.
- REQUEST TO PR.7 — master cell label “Fulfilment (product default)”; request posted. No UI file touched by PR.3.
- REQUEST TO PR.4 — additional label-repair push-lock request accepted and applied after MX.F explicitly released the browser hold. Canonical refusal sentences returned; final nine tests included.
- QUESTION: no outstanding Owner question blocks the authorized W1 work. No approval for production/channel writes was inferred; no such writes or commits occurred.

## Owner-requested route-ratchet follow-up — 2026-09-13T18:39:25.961667+00:00

The Owner's “please get it all done” follow-up authorized clearing the three attributed route-Prisma failures. The existing language matching and HTTP behavior are preserved. All six new registered-route characterization tests passed before extraction and after it. No baseline was raised.

| Route / content anchor | Before → after direct DB calls | Change |
|---|---:|---|
| assets.routes.ts / PUT and DELETE locale-overlays | 64 → 62 (baseline62) | Both alias-aware pre-reads delegate to findAssetOverlayForLanguage; existing regional upsert key/canonical selection and exact-ID delete preserved. |
| brand-story.routes.ts / create duplicate check and localize idempotency | 33 → 31 (baseline32) | Both delegate to findBrandStoryForLanguage with their original brand/market predicates; language normalization, ambiguity refusal and existing-row return preserved. |
| catalog-transfer.routes.ts / languages and readiness/options | 2 → 0 (baseline0) | Delegate to catalogTransferLanguages/catalogReadinessOptions in the existing export/options service. Keep all active readiness markets, response fields/order, source-first language choices and connection labels. |

One follow-up validation series: API tsc exit0 with private build-info; API vitest from apps/api4files/19pass/1skip, exit0,1.44seconds; route-Prisma ratchet exit0,3406calls/125files against3491baseline, no file rose. The single skip is the existing opt-in long-running browser fixture, not a skipped functional assertion. Local DB target printed127.0.0.1/nexus_development; all DB/transport seams in these tests are mocked. Counts are not combined with this series: the original PR.3 final run remains174/174, including13 actual local DB cases. This follow-up reruns only checks relevant to the new extraction.

Tests include real registered Fastify handlers for regional overlay updates, canonical precedence, no-match and ambiguous delete refusal, Brand Story duplicate rejection/different-language creation/idempotent localization; configured multilingual/scalar market choices, missing-language refusal, readiness response fields/order; existing catalog export and HTTP transfer suites. Before snapshots, exact additional diff, SHA256s, commands/loads/exits and logs are retained in route-followup* beside this report.

HANDOFF TO PR.1: the marketplaces publish and ebay-flat-file push-guard hunks were explicitly released; PR.1's18:36:19Z receipt reports39/39 route tests and actual shared-tree push checker0 at44functions. PR.4 has since continued its separately owned expanded sweep, so this report does not post W1.5-PUSH DONE. Other lanes retain their work and gating; no programme-wide completion, new schema availability, Wave4 approval or channel capability is inferred.

ASSUMED: the existing ambiguity response (500) is characterized and preserved by this extraction; changing its HTTP semantics was outside the three route-ratchet repairs. No unresolved PR.3 question remains. No production/channel write, editor change, server restart, commit or deployment in this follow-up.

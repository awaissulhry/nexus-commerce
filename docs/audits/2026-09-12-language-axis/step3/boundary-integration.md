# Step 3 boundary integration — Q-LX3-1 accepted, readers switched

Owner acceptance on 2026-09-12 permits R10, R2, R6, R7 and R8. The source flag now defaults to `NEXUS_CONTENT_RESOLVER=v2`; no Railway environment variable or deployment was changed. `DEFAULT_LOCALE` and the Appendix B content cascades are removed. The single implementation of `normalizeLanguage` lives in `packages/shared/content-language.ts` and is re-exported from `apps/api/src/services/pim/content-language.ts`. Existing regional keys are interpreted in memory; canonical keys win, ambiguous regional-only matches refuse. No keys or rows are folded, copied, cleared or backfilled.

## Translation-missing consumers

`pim/content-resolver.ts::translationMissing` tests `resolved.language !== normalizeLanguage(requested)`. Emptiness remains a separate requirement check: an Italian fallback cannot fill German; an intentional same-language clear is not a missing translation, although a required empty field still fails validation. Existing wire names `requestedLocale` and `effectiveLocale` carry requested and resolved language respectively.

| Consumer | Producer and check |
|---|---|
| `pim/readiness.service.ts::evaluateRow` (LX.5 rule now) | The sheet passes resolved language facts; values in a different language are excluded from required scalar/list validation. `content-readiness.vitest.test.ts` proves Italian title → German blocked and a German translation → filled in the same test. The index/table/job remain Step 5. |
| `pim/studio-sheet.service.ts` readiness, cell metadata and alias coverage | Resolver/mapping actual language feeds `translationMissing`; requiredness and non-empty checks follow that language check. |
| `pim/sheet-rows.service.ts::computeReadiness`, `completenessFor` | Coordinate language and effective language drive missingness. Content readiness refuses an unhydrated language coordinate; historical fact-only callers need no content address. |
| `pim/listing-readiness.service.ts::preparationIssues` | Compares effective and requested language, independent of non-empty fallback. Mapping preparation/payload consumers receive that result without inspecting fallback text. |
| `translation-completeness.service.ts::translationCoverage`, `computeLocalePct`, `computeLocaleCompleteness` | Batch resolver; count only values whose actual language matches requested, then test filled/reviewed separately. Existing command-matrix wire columns remain for Step 7. |
| `routes/families.routes.ts` `/products/translation-coverage/bulk` | Loads product and parent translations, derives coverage through the preceding function for configured and present languages. |
| `routes/products-catalog.routes.ts` command matrix | Hydrates native source and table rows; passes the product to the same coverage function. |
| `family-completeness.service.ts` | Declared localizable family fields resolve at primary language; a translation in another language cannot fill a missing primary field. |
| AI targeting: `ai/enrichment/draft.service.ts::loadCurrentValues` | Translation cells resolve first; actual/requested mismatch produces a missing target even when source fallback is non-empty. Tests cover missing French and existing German without generation. |
| AI targeting: `apps/web/src/app/products/_lenses/TranslationsLens.tsx` | Existing filter uses bulk coverage `fieldCount`/`hasContent` from the resolver-backed endpoint above. It never derives missingness from displayed fallback text. No UI or AI provider invocation was needed. |
| `pim/resolve-channel-field.ts`, `mapping/resolve-batch.service.ts` | Mapping source, fallback and expression dependencies retain actual language; `needsTranslation` uses that fact after transforms. Explicit-language paths retain the listing/account context. |
| `pim/mapping/cell-formula.service.ts` | Source eligibility tests actual/requested mismatch; outdated is an additional, separate review condition. |
| `pim/catalog-transfer-plan.ts::masterTransferState` | Resolves product/parent table rows and native source; different language means inherited/missing target. Tests cover fallback, parent translation and explicit same-language clear. |
| `pim/catalog-transfer-effects.ts`, `catalog-transfer-export.ts`, `catalog-product-transfer.ts` | Preview labels use resolved language; export uses the preceding state; choices use table languages. Context and export loaders hydrate parent/table rows. The source core row keeps its existing export shape without an automatic duplicate primary-language row. |
| `pim/content-read.ts::contentAttribute`, Etsy and Shopify readers | The canonical resolver supplies language metadata. Shopify sheet projection retains those facts; provider-owned factual fields do not manufacture a second translation state from snapshot nulls. |

Coverage and targeting behavior is tested in `pim/content-read.vitest.test.ts`; LX.5 and list-clear regressions are in `pim/content-readiness.vitest.test.ts`. No consumer treats `value == null` as evidence that a language translation is missing.

## Appendix B reader destinations

| Boundary | Switched behavior |
|---|---|
| `pim/attribute-resolver.ts` | Fact cascade retained; localizable fields come from `resolveContentBatch` through `content-read.ts`. Old locale branches and `DEFAULT_LOCALE` deleted. |
| `pim/resolve-channel-field.ts` | Mapping, transformations and links retained; localizable source paths call the resolver. `localizedContent.<tag>.<field>` remains a supported mapping address, with no JSON value read. |
| `pim/content-locale.ts` | `sourceContent`, `contentSlots` and review projections read the resolver/table. No backfill reader or moving script exists. |
| `etsy/information-content.ts`, `shopify/listing-information-plan.ts`, `shopify/content-workspace.service.ts` | Product/listing/parent translations and ordered marketplace languages are hydrated. Legacy locale/store bags do not supply product text. |
| `products/translation-resolver.service.ts`, `routes/product-translations.routes.ts`, `pim/global-content.ts` | Product API and global reads share the resolver; both top-level arrays and `fields[].value` retain `[]`. |
| `pim/studio-sheet.service.ts`, `sheet-rows.service.ts` | Both sheet adapters use canonical field values and old wire metadata names. Listing selects carry workspace/account/alias identity. Explicit child clears cannot resurrect a parent value. |
| `routes/listings-syndication.routes.ts::extractLocaleTitle` | Resolved source/table/legacy-pin title replaces outbound-attribute extraction; poisoned outbound values are ignored in unit tests. No publication is run. |
| `images/product-media.service.ts` | Product display title comes from the resolver. Media caption/collection data stays in its existing media-owned storage. |
| `pim/mapping/{resolve-batch,cell-formula,master-rule,mapping-sources}.service.ts`, `mapping-simulate.service.ts`, `routes/pim-global.routes.ts` | Every active attribute/source caller hydrates table rows and parent, and listing authority where relevant. Mapping-source inventory no longer walks legacy JSON. |

`pim/resolver-shadow.ts` is the historical mapping diagnostic and is disabled when v2 is enabled. The pre-switch language shadow source was archived as `step3-switch/accepted-shadow-source.ts.txt`; its accepted bundle and tests remain immutable reference evidence. The rerunnable post-switch script is `step3-switch/shadow.mjs`, built by `build-shadow.mjs` from actual reader functions with throwing application-DB/provider stubs. It compares to the frozen accepted candidate and additionally checks all 14,033 stored accepted next values. It adds a full sheet-wire projection matrix. The report distinguishes production-empty store readers from non-vacuous Etsy/Shopify offline controls.

## LX.4 addresses and preserved stores

| Grain | Read/write boundary normalization |
|---|---|
| PIM requests, information locale, sheet columns, market authority | `information-locale.ts`, `sheet-columns.service.ts`, `market-languages.ts`; language membership uses ordered `Marketplace.languages`. Regional delivery serialization remains `languageTag`. |
| ProductTranslation / legacy route compatibility | `product-translations.routes.ts`, `translation-write.ts`, `localized-content.ts`; new request addresses normalize. Writer retirement and pin writes are Step 4. |
| ProductSeo | `product-seo.routes.ts`, `ai/seo-regen.service.ts`; existing regional row selected in memory and kept under its stored key. Historical `default` maps to the sole primary constant. |
| APlusContent / BrandStory | Respective routes normalize internal read responses/create/clone addresses; existing regional siblings are matched without changing their key. Amazon services derive provider tags at the outbound boundary. No provider calls performed. |
| ProductAiDraft | `draft.service.ts`, `generate.service.ts`, `cell-key.ts`, `product-enrichment.routes.ts`; request, address key, creation and stored-tag filtering share the normalizer. No machine draft created or accepted. |
| CellFormula | `cell-formula.service.ts`, `formula-storage.ts`, `cell-formula.routes.ts`; stored regional addresses are matched in memory, existing writes keep row identity, new addresses normalize. Formula graph sibling selection uses normalized language. |
| AssetLocaleOverlay | `assets.routes.ts`, `asset-locale-overlay.service.ts`; normalized read projection and existing-row matching; no key folding. |
| Media collections/captions | `packages/shared/product-media.ts`, `images/product-media.service.ts`; one normalizer, `und` remains the neutral media address, original JSON is untouched. |
| Catalogue file/workbook addresses | `catalog-transfer-file.ts`, `catalog-workbook-scopes.ts`, `catalog-amazon-workbook.ts`, product/plan/export services normalize addresses. No catalogue import, apply, migration or backfill executed. |

`legacy-content-write.ts::legacyContentSlotsForWrite` is limited to the existing writer/CAS merge paths in `localized-content.ts`, `translation-write.ts` and `mapping/formula-storage.ts`. It preserves legacy values until the named Step 4 writer switch. Media-owned JSON and verbatim snapshots retain their grain. None of these exceptions permits an Appendix B product-content reader to consult legacy JSON.

## R2 follow-flag receipt and Step 4 contract

One query only, production snapshot **2026-09-12T06:53:09.264Z**, read-only transaction rolled back. The accepted 866 observations reference 575 distinct listings:

| Field | follow=true: drift | follow=false: operator pin | null |
|---|---:|---:|---:|
| title | 365 | 279 | 0 |
| description | 222 | 0 | 0 |
| Total observations | 587 | 279 | 0 |

These are observations, not 866 distinct listing records. Exact flags and classified observations are in `step3-switch/r2-flags.json`. Following text preserves the accepted value but resolves with `follows: true`, `drift: true`, inherited provenance and `channelSnapshot` source. It is **not an operator pin**. `isOperatorContentPin` requires `tier === 'pin' && follows !== true`; Step 4 routing must consume this fact and must never route an edit on the 587 following observations as a pin change. The test covers both sides of the flag.

Protected flat-file runtime files and `channel-batch/amazon-batch-feed.service.ts` remain exempt and untouched. The separately authorized GPSR test fixture patch predates this switch. No trigger, function, migration, business-data write, provider call, publish rehearsal, commit, push or deployment is part of this switch. Screen verification remains Step 6; this record does not claim a visible Languages view.

## Final gate evidence

The one switched-reader production run used snapshot **2026-09-12T08:00:15.514Z** and rolled back. It checked **1,171,843** observations, including the original **692,203** reader observations and **479,640** added sheet-wire projections. All **14,033** recorded accepted next values matched, with no omissions. The raw instrument reported one added sheet-wire expectation mismatch: `GALE-JACKET-BLACK-MEN-XL` / Amazon IT / bulletPoints contains an empty fourth slot. The existing unbounded-list wire projector compacts that slot. Its file is byte-identical to the pre-switch snapshot.

The raw report is preserved as `step3-switch/measured-production-shadow.json` and was not overwritten with a green result. `wire-expectation-replay.mjs` replays only that captured observation offline against the unchanged projector, checks every measured application reader hash and proves **zero behavior differences**. It also rejects loss of a non-empty item and checks the empty slot's individual-cell projection remains null. No application code changed to erase the difference, and no production shadow/query was rerun. The reusable instrument now applies that established projection to expected sheet lists. This is an instrument expectation correction under the Owner's unchanged-wire condition, not a new content reclassification.

`step3-switch/counts-by-field-language.md` contains all 71 fields × 9 languages; `verified-counts-by-field-language.json` retains reader/field/language detail. `measured-*` files preserve the original expectation and bundle. All 13 measured table hashes match the previously accepted snapshot. The two frontend wire mirrors keep the language metadata vocabulary; the channel source type now accepts `channelSnapshot`. The node-only `sheet/content-wire.vitest.test.ts` tests these facts against the server declaration. Existing screen layout and controls were not changed.

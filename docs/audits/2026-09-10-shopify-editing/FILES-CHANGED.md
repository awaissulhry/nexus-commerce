# Shopify editing implementation files

This is the focused implementation surface for this task, not the repository-wide dirty-file list. The shared working tree already contained extensive unrelated work. No reset, stash, commit, push, deployment or real Shopify mutation was performed. Earlier work in these files was retained.

## Shared contracts and codecs

Under `packages/shared/`:

- `shopify-information.ts`: native registry, capabilities, accurate immutable/computed reasons and validation.
- `shopify-information-inventory.ts`, `shopify-information-translations.ts`: exact stock/translation identities and contracts.
- `shopify-linked-products.ts`, `shopify-field-codecs.ts`: dynamic definitions, applicability, supported scalar/list/object/reference families and validation.
- `shopify-json.ts`, `json-bigint.d.ts`: lossless structured-value handling.
- `shopify-reference-validation.ts`, `shopify-definition-validation.ts`: authoritative reference constraints, JSON schema and declared validation rules.
- `shopify-content.ts`: typed media content, gallery order and localized accessibility manifest.
- `shopify-information.vitest.test.ts`, `shopify-linked-products.vitest.test.ts`, `shopify-field-codecs.vitest.test.ts`, `shopify-definition-validation.vitest.test.ts`: contract coverage.
- `package.json` and root `package-lock.json`: explicit lossless JSON / JSON-schema validation dependencies. Shared build regenerated ignored `dist` output.

## API

Under `apps/api/src/services/shopify/`:

- `linked-products-gateway.ts`: paginated definitions/capabilities/references, bounded store/profile constraint caching and fresh category applicability queries.
- `linked-products.service.ts`: validated drafts, exact owners, version checks, reviewed plans, compare-digest batches, recovery and audit.
- `linked-metaobjects.service.ts`: protected/shared entry validation and explicit Shopify saves.
- `information-gateway.ts`: narrow native readers/writers, recorded publication date, category/handle handling and readback.
- `information-inventory.ts`, `information-publications.ts`, `information-translations.ts`, `information-media-membership.ts`: field-family-specific synchronization operations.
- `listing-information-plan.ts`, `listing-media-content.ts`: unlinked override/media validation, review and exact-owner publication planning.
- `content-workspace.service.ts`, `content-sync.service.ts`, `content-publisher.ts`: locale/alias isolation, media preservation, durable job recovery, category initialization, verified final status and variant identity persistence.
- Focused tests: `linked-products.vitest.test.ts`, `linked-metaobjects.vitest.test.ts`, `information-gateway.vitest.test.ts`, `information-native-fields.vitest.test.ts`, `information-inventory.vitest.test.ts`, `information-publications.vitest.test.ts`, `information-translations.vitest.test.ts`, `information-media-membership.vitest.test.ts`, `listing-information-plan.vitest.test.ts`, `listing-media-content.vitest.test.ts`, `content-gallery-recovery.vitest.test.ts`, `content-sync-status.vitest.test.ts`.

Other API paths:

- `services/pim/channel-specs/store.ts`, `services/pim/channel-specs/shopify.ts`, `services/pim/sheet-columns.service.ts`, `services/pim/studio-columns.ts`, `services/pim/studio-sheet.service.ts`: dynamic chooser columns, authoritative editability, listing routing, owner/category applicability and locale storage.
- `services/products/bulk-edit.service.ts`: typed Shopify writes to the exact listing; preserves raw structures and literal text, validates currency/applicability and refuses parent cascade.
- `routes/images/shopify-linked-products.routes.ts`: destination/locale parsing, media/inventory permissions and explicit constraint refresh.
- `routes/products-bulk-noop.vitest.test.ts`, `routes/images/shopify-information-permissions.vitest.test.ts`, `services/pim/channel-specs/shopify-schema.vitest.test.ts`, `services/pim/channel-specs/shopify-mapping.vitest.test.ts`, `services/pim/channel-specs/store.vitest.test.ts`: routing, values, clears, authorization and schema lifecycle coverage.

## Product editor UI

All paths below are under `apps/web/src/app/products/[id]/edit/_studio/`:

- `contracts.tsx`, `StudioBar.tsx`, `shopify/ShopifyLinkedRoute.tsx`, `shopify/useLiveShopifySchema.ts`, `sheet/channel/ChannelScopeTab.tsx`: content-language selection, keyed scope isolation, live schema refresh and composed unsaved guards. `StudioTabHost.tsx` now routes all channels to ChannelScopeTab; the native/linked Information split is removed.
- `shopify/ShopifyInformationGrid.tsx` was removed. `shopify/ShopifyLinkedWorkspace.tsx` retains family/content tools and legacy draft recovery, with the Information branches removed.
- `shopify/LinkedFieldEditor.tsx`, `shopify/ShopifyCompoundEditor.tsx`, `shopify/ShopifyNativeEditor.tsx`, `shopify/EntryEditor.tsx`: compact typed controls, exact references, metadata preservation and explicit shared-entry save.
- `shopify/ShopifyDraftCell.tsx`, `sheet/channel/ChannelSheet.tsx`: functioning unlinked AG editor gateway and sheet persistence.
- `shopify/informationEditing.ts`, `shopify/informationTransfer.ts`, `shopify/shopifyGridTransfer.ts`, `shopify/unlinkedInformationColumns.ts`, `shopify/draftMerge.ts`: shared editing/transfer capabilities, category constraints and three-way draft merge.
- `shopify/InformationMediaDialog.tsx`, `media/ProductMediaDialog.tsx`: gallery membership/accessibility review; product-media Modal reduced from extra-large to large.
- `images/shopify/ShopifyContentWorkspace.tsx`, `images/shopify/ShopifyFieldValue.tsx`: reviewed listing overrides, accessibility content and lossless rich-text leaf editing.
- `shopify/linked.module.css`: undefined notice z-index token replaced with `--nds-z-actionbar`; domain layout only.
- `shopify/linked-editor.vitest.test.ts`, `shopify/informationEditing.vitest.test.ts`, `shopify/informationTransfer.vitest.test.ts`, `shopify/unlinkedInformationColumns.vitest.test.ts`, `shopify/draftMerge.vitest.test.ts`: relevant editor/transfer/recovery tests. Existing `schemaRefresh` and media-transfer tests were also run.

## Design-system effects

No shared design-system source, grid selection CSS, loading overlay, density, row height, cell padding, typography token or Factory source was changed by this task. Existing Modal, Field, Input, Select, DateField, OrderedList, Disclosure, Banner, buttons, tooltips and grid primitives were composed. There is no new reusable control requiring an export/catalog/changelog/DS-GAPS/Factory addition.

The fork guard reports unrelated `components/index.ts` drift between Web and Factory (three blank lines in their direct difference), alongside previously recorded fork differences. It was not overwritten or rebaselined. Other relevant token/CSS/grid guards passed.

## Evidence and audit updates

This directory contains the field/type inventory generator, read-only capability checker, historical JSON receipts/screenshots and delivery documents. The isolated port 3175 browser-fixture source was deleted at the user’s request. The READMEs in `2026-09-10-shopify-information/` and `2026-09-10-product-media/` gain a short pointer to this follow-up; their historical evidence remains intact.

## Common channel-sheet consolidation

- API: `services/shopify/channel-sheet-projection.ts`, `channel-sheet.service.ts`, `channel-sheet.vitest.test.ts`; `routes/product-studio.routes.ts`; `routes/images/shopify-linked-products.routes.ts`; permission manifest and route tests.
- Shared: `shopify-sheet.ts`, `shopify-information-editing.ts`, `shopify-information.ts`, package exports. Common row addresses, first-baseline preservation, draft-cell concurrency and Nexus-to-Shopify weight-unit conversion.
- Web: `StudioTabHost.tsx`; `ChannelScopeTab.tsx`, `ChannelSheet.tsx`, `useChannelSheet.ts`, `CascadeCell.tsx`, row types; `sheetRecovery.ts`, `useReferenceNames.ts`; `ShopifyDraftCell.tsx`, `ShopifySheetReview.tsx`, `channelSheetWriter.ts` and tests; live-schema hook and column decoration; removed obsolete linked Information route branches.
- Editable listing SKU is distinct from the reserved Nexus SKU identity band in the shared registry/store spec. Existing `platformAttributes.sku` data is preserved.
- `content-publisher.ts` and gallery recovery tests now accept the correct Video and Model3d file identities as well as MediaImage.
- No shared design-system source, selection CSS, grid theme, density, cell padding or row-height change in this consolidation. No Factory mirror change required.

- Durable content overrides: `packages/shared/shopify-linked-products.ts`, shared sheet contract, `channel-sheet.service.ts`, `channel-sheet-projection.ts`, and the existing draft merge now keep pins after synchronization and stage authoritative Reset values. `listing-sheet-values.ts` and its tests preserve them through full content publication.
- Common gallery synchronization: `channel-sheet-media.ts` plus protocol and durable-operation tests; `linked-products.service.ts`, `linked-automation.service.ts`, protected-state guard and route permissions. `content-publisher.ts` supports listing-scoped file identities and correct video/model GID types.
- Common review/recovery: `ShopifySheetReview.tsx`, domain `ShopifyGalleryReview.tsx`, existing family review; media explanatory copy in `ProductMediaDialog.tsx`. No shared design-system control changed.
- Store capabilities: `linked-products-gateway.ts`, shared native schema validation, `shopifyProductSpec`, and `ShopifyNativeEditor` derive inventory-policy choices from pinned API introspection.
- Current evidence: `COMMON-CHANNEL-SHEET.md`, `common-channel-api-tests.json`, `common-channel-verification.json`, common check logs, range screenshots and `live-gallery-capabilities-1.json`.

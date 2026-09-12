# Common channel sheet — current implementation

Shopify, Amazon, eBay and the other connected channels now enter the same `ChannelScopeTab` → `ChannelSheet`. The grid keeps the shared product family's Nexus row identities, hierarchy, column chooser, selection, keyboard handling, media dialog and design-system controls. Shopify's schema and persistence adapters supply its applicable fields; there is no separate Shopify Information grid.

`ShopifyInformationGrid.tsx` and its route branch were removed. The port **3175** browser fixture was stopped and its `browser-fixture/` source directory deleted at the user's request. No listener remained on 3175 at verification. Historical screenshots and receipts remain explicitly historical. The other sessions' fixtures were left alone.

The actual editor checked was `http://localhost:3000/products/cmokmy3a40078pm0p1fvnu523/edit/studio?market=GLOBAL&locale=en&scope=SHOPIFY`. The supplied `market=BE` route remains the real editor; Shopify resolves its base destination to GLOBAL. Shared product and channel views use the common grid foundation, while channel views all use this single ChannelSheet component. Shopify-specific schema, validation and API operations remain separate domain adapters.

## Field coverage and persistence

The [generated field table](FIELD-COVERAGE.md) inventories every native field, observed dynamic definition and advertised API type, with owner, applicability, reader, editor, Nexus storage, Shopify operation and evidence level.

| Family | Coverage | Current evidence |
| --- | --- | --- |
| Native Shopify fields | 27 editable logical fields; 28 physical columns because inventory has Available and On hand | Typed editor/writer contracts, production read adapters, pinned API introspection; representative browser opening/keyboard checks |
| Product/variant metafield definitions | All 39 observed definitions have type adapters, subject to owner, category and permissions | Generated from live definition schema; shared codec, validation, exact-store reference and writer tests |
| Computed/API-restricted native fields | 3: schedule, publish date, package | Specific reasons in the complete table; pinned read/schema evidence |
| Dynamic type catalog | 117 of 118 advertised types have value adapters | Type-family tests; the internal taxonomy-disclosure resource is absent in 2026-07 |
| Common structural columns | Product role and Parent SKU | Shared sheet columns, rather than Shopify attributes; they explain why the actual chooser shows 72 rather than 70 |

Linked field saves retain content pins in `_nexusLinkedProducts.sheetValues`, separately from pending native/metafield commands and their original remote baselines. Equal-value pins, null clears, empty strings, false and zero survive reload and verified synchronization. Reset reads the authoritative shared mapping and stages its value; client-supplied reset text is ignored. Full content publication consumes the durable pins through the existing listing adapter. Older family/editor saves cannot erase this server-owned pin metadata.

Inventory is an operational value: its exact-location adjustment persists until verified, after which the sheet reads current Shopify quantities. It is not a permanent fixed content override. No shared stock scalar is substituted for Shopify's location records.

Unlinked drafts retain the existing exact listing/account/alias/GLOBAL/locale autosave path. The reviewed publication creates Shopify owners and consumes typed listing overrides. No shared Product is the target of a Shopify field edit. New definitions of supported types use the shared type/capability system; unknown types retain their data and explain that a Nexus adapter is needed.

## Common media workflow

All channels use `ProductMediaDialog`, `productMediaColumn`, the Nexus media library and typed gallery transfer. Saving a gallery writes the exact listing's `_productMediaLocales` collection with a revision check. Uploading to the Nexus library and saving a gallery are separate actions.

For existing Shopify owners, the same common preflight review now includes the gallery's exact product or variant. Its durable linked operation owns file creation, product association changes, order jobs, variant image assignment and image-alt translations. No upload or Shopify mutation occurs during draft save or review. A lost upload acknowledgement reuses the stable file identity. A lost association response reconciles membership. Known reorder jobs remain pending until completion and readback. Newer Nexus gallery intent or external Shopify changes stop stale operations without discarding the draft. Final verification checks order, base alt text, variant assignment and localized alt text before recording `_nexusSheetMediaSync`.

Native variant galleries accept one image. Product rows support complete image/video/3D galleries. Replacing a product gallery reviews the affected variant associations; files are detached, not deleted. Files used for localized metadata are scoped to the exact listing so its alt translations cannot overwrite another listing's file metadata.

Shopify has one gallery membership/order across languages. Image alt is translatable; video/model alt is shared. Captions and transcripts remain in Nexus for native gallery synchronization, because Shopify's native file mutations do not accept those fields. This exclusion appears in the review. The existing theme content publication handles its accessibility manifest separately. These restrictions do not prevent supported native gallery edits.

The common review provides an explicit path to read current Shopify baselines and retain draft intent after an unverified operation. It refuses to replace the review while a known submitted media job can still finish. An unknown job acknowledgement remains an explicit reconciliation limitation.

## Verification evidence

| Check | Result |
| --- | --- |
| API focused suites | **326 passed**, 1 conditional browser-fixture test skipped; 28 files. [Machine-readable report](common-channel-api-tests.json) |
| Web typed editor, transfer, common writer and recovery suites | **115 passed**, 11 files |
| Shared codec, validation and linked-draft suites | **48 passed**, 4 files |
| Shared build; API and Web type checks | Passed |
| Web and Factory token checks | Passed |
| CSS parser; raw-control and raw-hex ratchets; token resolution | Passed; token resolution reports existing runtime/fallback notices |
| AG module and import-boundary guards | Passed |
| Grid chrome guard | Passed: 3 densities × 2 themes × 2 viewports, 12 probes |
| Focused diff whitespace check | Passed |
| Design-system fork guard | **Unrelated existing failure:** `components/index.ts` differs between Web and Factory. This task did not edit either shared export file or rebaseline the guard. |

The API suite emitted existing background Redis connection warnings during route tests; assertions still passed. They were not suppressed. The skipped test requires an isolated browser-fixture environment and is not counted as browser coverage.

Production-component browser observations on the real editor:

- 21 Nexus rows, existing product/variant hierarchy, 72 chooser columns, Shopify GLOBAL and the store's primary English locale. Switching to Amazon and eBay showed the same Information region, Find/Customise controls and tree grid; Amazon retained 36 px rows.
- Pencil and F2 opened the same Name editor. It measured **440 × 234.6 px** at a 1728 × 906 viewport, with no horizontal overflow. Cancel restored `name` on `primary:cmokmy3a40078pm0p1fvnu523`.
- Native Shift+Right selected a two-cell range. Existing 36 px row height and 0 px / 9 px cell padding remained. The light contour token was `#1f6fde`; dark used the existing `#6d9ee8` token. No selection CSS, border thickness, density or loading overlay was changed. [Light screenshot](common-sheet-range-light.jpg), [dark screenshot](common-sheet-range-dark.jpg).
- The common media dialog loaded 24 library items, measured **660 × 742.9 px**, had no horizontal overflow, and restored focus to `productMedia` on the same row after Cancel. Its ordered-list actions and form controls had screen-reader names.
- The common Customise panel included current dynamically discovered metafields and the distinct listing SKU column. Opening and cancelling did not change the saved layout.
- Temporary API watcher restarts during shared builds caused transient load failures. Reloading after the API recovered opened the real sheet. The loading/error state did not overwrite draft values.

Browser scope: real catalog edits and Shopify mutations were not performed. Earlier fixture title/structured-value save receipts predate the final consolidation and are historical, not current live round-trip evidence. A full final browser save/hard-refresh/copy-paste/drag-fill/undo workflow across multiple stores and locales remains unverified. Automated tests cover those write/transfer boundaries, clearing, stale writes and partial failures. The grid guard covers narrow/wide layouts and themes; final editor-specific zoom, reduced-motion and screen-reader behavior were not exhaustively exercised. This is not an accessibility certification.

Undo/redo applies to the common grid's edit commands. A completed Shopify synchronization, Nexus library upload or separately reviewed reusable-entry save is outside grid undo. Recovery retains unconfirmed cell input; reverting a verified Shopify change requires another reviewed operation.

## Pinned Shopify API evidence

The API stays on **2026-07**. [Read-only gallery introspection](live-gallery-capabilities-1.json) confirmed `fileCreate`, `fileUpdate`, `productReorderMedia`, `productVariantAppendMedia`, `productVariantDetachMedia`, `translationsRegister`, their inputs, translatable image alt, and the one-media-per-variant input error. No mutation was submitted. Native definitions and other operation evidence remain linked from [README](README.md).

Official documentation: [variant media assignment](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productVariantAppendMedia), [variant media removal](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productvariantdetachmedia), [media errors](https://shopify.dev/docs/api/admin-graphql/latest/enums/MediaUserErrorCode), [translation registration](https://shopify.dev/docs/api/admin-graphql/latest/mutations/translationsRegister). Versioned live introspection, rather than the mutable documentation selector, is the operation-availability evidence.

## Changed files and shared effects

See [FILES-CHANGED](FILES-CHANGED.md). The routing, common sheet integration and Shopify adapters changed. The obsolete grid and 3175 fixture were removed. No shared design-system component, theme, selection styling or Factory component was changed during the consolidation. Existing Nexus primitives are composed by the typed editors and review; the domain gallery review is reused by the sheet and family review. The small media explanatory-copy change applies through the existing common dialog to all channels.

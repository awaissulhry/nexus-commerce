# Shopify Information workspace

> Architecture update: [all channels now use the common channel sheet](../2026-09-10-shopify-editing/COMMON-CHANNEL-SHEET.md). Statements below about a separate native Shopify Information grid/media dialog are historical.

> Follow-up (2026-09-10): [Shopify editing implementation and current field coverage](../2026-09-10-shopify-editing/README.md) supersedes the Shopify editing-gap statements below. This file preserves the earlier evidence. The follow-up adds native fields, structured channel drafts, scoped publication/translation/media adapters and recovery; live mutation and storefront verification remain separate.


## Implementation status

Shopify product fields, metafields and reusable content now open on the product **Information** page. The separate Metafields & content navigation item is removed; its existing deep route remains compatible. The grid uses NexusGrid, the existing Shopify workspace draft, typed reference editors and the existing synchronization service. Unlinked listings retain their previous channel information sheet.

**This is an implemented, tested subset of the supplied specification, not completed Shopify parity or a WCAG AAA claim.** The audited chooser contains all 60 labels in eight groups and renders 61 columns. In the connected store, 14 scalar fields, gallery reordering and 23 definition-backed fields are enabled. Twenty-two audited fields remain read-only. Adding a field to the chooser is not counted as a successful mutation test.

- [Exact 60-field coverage and operation mappings](coverage.md)
- [Machine-readable column catalog](shopify-column-catalog.json)
- [Read-only store schema evidence](live-read-evidence.json)
- [Acceptance results](acceptance.md)
- [Verification record](verification.json)

The implementation has product/variant ownership guards; persistent visibility, order, widths and density; presets; contextual tooltips; inline and modal editing; compatible paste/fill review; unsaved undo/redo; hidden/collapsed draft review; session recovery; compact reference previews; and a compact gallery with stable-ID pointer/keyboard ordering and explicit positions. Pointer dragging and clipboard integration still require browser verification. Shared entries keep independent review/save boundaries and actual usage disclosure.

The native adapter sends narrow product/variant patches. Baseline reads use batches of at most 50 owners and do not traverse the variant matrix or gallery for each scalar edit. Gallery synchronization checkpoints submission and job identity, waits for completion, then verifies the exact remote order. Failed and uncertain operations retain their intended draft. Existing audit records now include the actor, listing/store scope, operation ID, reviewed values and synchronization outcomes.

## Initial gap map

| Area | Existing foundation | Work / discovery boundary |
| --- | --- | --- |
| Field registry | Store core-field contracts; live product/variant metafield and metaobject definitions | Add the audited 60-label parity catalog, resolve definitions by owner and namespace/key, and expose unavailable capabilities truthfully. |
| Grid | NexusGrid, virtualized sheet host, keyboard selection, column/view persistence | Put Shopify content on Information with product/variant rows and contextual editors. Preserve the existing information sheet for unlinked drafts. |
| Assets | Shopify Files library, upload service, stable file IDs, Nexus media controls | Read native ordered galleries; stage reorder commands in the existing saved Shopify draft; verify asynchronous jobs and final order. Attachment, shared-file editing and transforms need separate scope validation. |
| References | Typed LinkedFieldEditor, reference search, shared EntryEditor, usage and duplicate flows | Reuse these within Information. Resolve previews in batches and preserve unavailable references. |
| Saving | Versioned ChannelListing JSON draft, compare-digest metafield changes, durable operation checkpoints and leases | Extend the existing draft and operation pipeline for narrowly scoped product/variant fields and media ordering. Never treat a job acknowledgement as synchronization. |
| Shopify | Server-only Admin client pinned to 2026-07, permission and publication gates | Inventory location/CAS authority, variant publication, scheduling, package, multiple barcodes and category applicability require dedicated capability work. Production mutation and publication are outside this verification. |

The user's supplied audit is the reference inventory; its relative screenshots and JSON were not present in the workspace. Existing local audits are background evidence, not verification of this change.

## Save boundary

Information edits accumulate in the existing Shopify workspace draft. Save draft persists in Nexus; Review & synchronize previews and applies the saved operations. Reusable entry edits retain their own explicit Shopify save boundary. Unlinked PIM listings continue to use the existing channel information sheet.

These edits are channel-specific commands attached to the existing ChannelListing, not changes to the shared canonical product record. The UI must not imply that an Information save updates every channel. Existing automatic shared-field rules cannot execute native or gallery edits. Normal full-product publication remains separately reviewed; the new information-only marker does not turn a native-variant listing into a linked-product family.

Unsaved drafts are recoverable in the current browser session. Restoration is automatic only after explicit Restore and only against the same saved revision. A changed saved revision is shown for review; it is never silently replaced. Undo history is bounded to 50 unsaved commands and ends at Save draft. Compensating undo after synchronization is not implemented. Native APIs have no compare-and-set option used here: read-before/write/readback reduces stale-write risk but cannot eliminate the race between the read and mutation. Metafields retain the existing compare-digest protection.

## Actual verification

All **181 relevant tests** passed: 122 in the eight Shopify API service suites, 36 shared contract tests and 23 web editing/navigation tests. Web, API and Factory type checks passed. Shared package build, both generated token checks, token resolution, CSS parsing, raw-control ratchet, design-system conformance and AG Grid import boundaries passed. The design-system fork check reported 130 identical shared files and six pre-existing differences, with no new drift. Token-resolution notices about existing fallback tokens elsewhere are informational; no unrelated guard failure was suppressed or rebaselined.

Read-only checks against `xaviaracing.myshopify.com`, API 2026-07, verified EUR, Europe/Rome, 76 registry entries including the 60 audited fields, 22 metaobject definitions, two products, ten variants and 13 media associations. The optimized native-owner query independently read all 12 owners and matched their product identities. These were the first two products returned by the store; they were not the audited MOSS/AIRMESH fixture. No live Shopify or database mutation was performed.

The isolated HTTP fixture renders the actual Studio components with two parents, 15 variants and six images per gallery. Browser actions saved a leading-zero SKU, reordered MOSS media, saved a Size Chart page reference, synchronized and reloaded. The receipts are [SKU round-trip](fixture-roundtrip.json) and [media/page round-trip](fixture-media-roundtrip.json). This proves fixture save/reload and UI behavior. API service tests separately exercise the actual adapter and durable queue against mocked Shopify and Prisma boundaries; neither is a development-store mutation test.

Browser checks covered inline SKU entry and Tab commit; nullable page-picker cancellation; shared-entry usage; saved revision recovery; hidden and collapsed dirty cells; range fill preview and one-step undo; explicit media positions; Space/arrow/Escape cancellation; interrupted synchronization followed by Resume; focus restoration; and light/dark responsive layout. A fixture navigation to the unimplemented Shared product endpoint produced a MasterSheet error; that endpoint is outside this fixture, and its output is not evidence of a production regression or a successful test. The Shopify route was restored and the Information checks continued.

Performance sample: Apple M5 Pro, 24 GiB, macOS 26.6.2, Chrome, local Vite development fixture. The synthetic large fixture has 10,000 variants plus two products and 61 columns; it is not a claim that Shopify permits 5,000 variants per product. The grid exposed 10,003 ARIA rows including the header, 61 ARIA columns, 37 mounted row elements and 216 cell elements at the sampled scroll position. Forty keyboard samples produced a p95 of **34.3 ms for a two-animation-frame next-paint proxy**. Actual paint latency, scrolling frame rate, long-running memory growth, remote hydration throughput and the 200 ms cached-media target were not measured.

Accessibility results are limited to keyboard and DOM inspection. Dialog focus remained contained and returned to its source cell; media movement and cancellation had visible live status; controls included product/variant/field names. The media guidance paragraph measured 7.38:1 contrast in dark mode (`rgb(170,182,194)` on `rgb(24,38,59)`) and 5.32:1 in light mode (`rgb(98,108,123)` on white). This is a text sample, not a full contrast audit. Screen-reader use, actual 200% browser zoom, reduced-motion behavior, all focus-obscuring cases and complete WCAG 2.2 AA/AAA assessment remain untested.

## Screenshots

Every screenshot below is the isolated Nexus fixture, with synthetic assets and a visible QA toolbar. None depicts a production save.

| State | Evidence |
| --- | --- |
| Information, light, 1342 px | [information-1342.png](screenshots/information-1342.png) |
| Column groups, required title and presets | [columns.png](screenshots/columns.png) |
| Gallery with larger first tile | [media-manager.png](screenshots/media-manager.png) |
| Gallery, dark, 1440 px | [media-dark.png](screenshots/media-dark.png) |
| Gallery, 390 px, keyboard cancellation | [media-mobile.png](screenshots/media-mobile.png) |
| Shared entry with three references | [shared-entry.png](screenshots/shared-entry.png) |
| Interrupted sync retains one pending change | [interrupted-sync.png](screenshots/interrupted-sync.png) |
| Typed theme content after page-reference reload | [theme-content.png](screenshots/theme-content.png) |
| Large dataset and timing proxy | [performance-10000.png](screenshots/performance-10000.png) |
| Large dataset, dark, 1920 px | [dark-1920.png](screenshots/dark-1920.png) |

The earlier `fill-preview.png` contains wording that was subsequently corrected; it is historical interaction evidence rather than a final wording screenshot.

## Remaining implementation and discovery

The following are gaps in this Information workspace, not assertions that Shopify cannot support them:

- **Assets:** gallery attachment selection/removal, per-file uploads, retry/cancellation, file usage lookup, filename/alt edits, duplicate-and-edit, focal point, crop/resize/draw/background editing, version recovery and image generation. The existing Shopify Files library and upload service are available in the repository but are not yet connected to this gallery draft. The current dialog supports reorder and inspection and explicitly directs attachment/shared-file work to Shopify. It exposes no nonfunctional upload or generation buttons.
- **Specialized fields:** status including Unlisted, discovered templates, category assignment/applicability preview, publishing and scheduling, inventory location/authority/idempotency, tracking, unit-price measurement, cost, package, weight, country picker and handle/redirect review. Read-only controls explain their limitation and preserve remote values. Some read-only cells say Unavailable because their read adapter is also absent.
- **Barcode version boundary:** 2026-07 cannot represent the newly announced 2026-10 typed barcode list through this adapter. Barcodes are read-only so secondary entries cannot be silently replaced. An API upgrade, schema check and full-set replacement tests are required.
- **Category discovery:** seven category fields have no resolved definition in this store schema read. Query the selected taxonomy category's standard definitions and canonical entries; do not invent namespace/key values from labels.
- **Rich editors:** Description currently uses full HTML source. Rich composition, embedded media/tables and sanitizer integration remain incomplete. Existing compound metafield editors preserve and validate declared serialization, but several use structured source controls rather than specialized measurement/money/rating editors.
- **References:** existing per-reference selection and ordered editing are reused. The audited multi-selection picker with staged Done/Cancel, typed chip clipboard transfer, cross-store mapping, category default-entry creation and complete shared duplication/browser round-trips remain to be implemented or verified.
- **Recovery and interaction:** undo after sync, all list append/remove/replace bulk commands, pointer fill/drag verification, nonadjacent selection across virtualized regions, actual clipboard integration, complete per-field partial-failure review and inherited-value provenance need further work. Current native synchronization patches one field per operation; grouped variant throughput is not optimized.
- **Release verification:** designate a development Shopify store with permitted writes and expected scope/authority. Exercise real native/metafield/media job round-trips, failure injection and storefront consumers there. No storefront behavior, development-store mutation, inventory concurrency or publication was verified in this change.

## Migration and local review

No database DDL is needed. Optional native/media commands and the information-only marker extend the existing versioned ChannelListing JSON draft and durable operation. AuditLog is reused. Deploy shared contracts, API and web together; an older strict contract does not understand these draft fields. An older client must not rewrite a draft containing newer commands. Rolling back requires reconciling pending operations first, not deleting intent or checkpoint data.

The shared Modal anchor, compact MediaGallery and OrderedList changes are mirrored in Factory, exported through existing component exports and documented in both catalogs/changelogs and `.claude/DS-GAPS.md`. Unrelated workspace changes and existing design-system fork differences were preserved. No commit, push or production deployment was performed.

Start the isolated fixture from the repository root with:

```sh
node docs/audits/2026-09-10-shopify-information/browser-fixture/server.mjs
```

Open `http://127.0.0.1:3144/products/store-demo/edit/studio?scope=SHOPIFY&market=GLOBAL&tab=sheet`. Fixture writes are process-local and survive browser reload only until the server restarts. Keep the explicit Shopify scope; this fixture does not implement the canonical Shared product sheet. The read-only discovery script is run from `apps/api` with `../../node_modules/.bin/tsx ../../docs/audits/2026-09-10-shopify-information/read-information.mts` and uses existing server credentials without printing them.

## Reference contracts

- [Shopify media ordering](https://shopify.dev/docs/api/admin-graphql/latest/mutations/productReorderMedia): sequential zero-based moves, asynchronous job and readback.
- [Product updates](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductUpdateInput): small product patches, separate category and redirect policy.
- [Variant inputs](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/ProductVariantsBulkInput) and [inventory-item inputs](https://shopify.dev/docs/api/admin-graphql/latest/input-objects/InventoryItemInput): correct field owners.
- [Multiple barcodes](https://shopify.dev/changelog/product-variant-barcode-is-being-replaced-by-barcodes): 2026-10 capability; this connector remains pinned to 2026-07.
- [W3C grid pattern](https://www.w3.org/WAI/ARIA/apg/patterns/grid/): grid navigation and editor focus boundaries.

# Product media attribute

> Architecture update: [all channels now use the common channel sheet](../2026-09-10-shopify-editing/COMMON-CHANNEL-SHEET.md). Statements below about a separate native Shopify Information grid/media dialog are historical.

> Follow-up (2026-09-10): [Shopify editing implementation and current field coverage](../2026-09-10-shopify-editing/README.md) supersedes the Shopify editing-gap statements below. This file preserves the earlier evidence. The follow-up adds native fields, structured channel drafts, scoped publication/translation/media adapters and recovery; live mutation and storefront verification remain separate.


The Shared product and channel sheets now expose one Product media column. The column uses a dedicated media editor instead of the ordinary text, formula or bulk-paste writer. Native linked Shopify Information keeps its existing attachment reorder and synchronization workflow and consumes the same mixed-media previews and thumbnail strip.

The editor supports image and video uploads through the existing product library endpoints, selection from the product/parent library, keyboard and pointer reordering, removal of gallery references, localized alt text, WebVTT caption references and plain-text transcripts. Removing a reference never deletes a source file. Uploads are retained immediately in the shared library, as stated next to the upload control. The current upload picker accepts images and MP4, MOV and WebM video; previewing an unsupported codec retains an original-file link.

## Destination and persistence

- Shared product galleries use `Product.localizedContent[locale]._productMedia`. Shared media applies across marketplaces (`market=GLOBAL`).
- Channel galleries use `ChannelListing.platformAttributes._productMediaLocales[locale]._productMedia`. The destination includes the exact product, channel, marketplace, account and listing or explicit alias. These are **Nexus authoring drafts**. Generic gallery drafts, translated metadata and captions are not automatically sent to channel APIs. The editor states that saving does not change live channel attachments. Publication adapters must consume this contract and validate their channel's rules before that integration is enabled.
- An unlisted row can read inherited media. Its first save creates an attributed, unpublished listing draft; reading never creates a listing.
- Resolution is exact locale, all languages (`und`), shared product, then the product/parent library. An explicitly empty gallery stops inheritance. A separate restore action removes an override.
- Asset references must belong to the selected product or its parent. Invalid saved collections are preserved and reported. Missing references remain visible until the operator resolves them.
- Save requires an observed SHA-256 revision. Serializable transactions and version checks prevent stale updates. Unknown save outcomes require a reload; the local draft remains visible. Scope-change and unload guards protect unsaved edits.
- Read access uses `products.view`; saves and video uploads require `products.images.edit`. Database access uses the existing workspace-scoped Prisma client.

## Shared UI

`MediaPreview` provides image, native video/audio, external-video and unknown-file presentation. Video has explicit controls, alternative sources, captions, a transcript disclosure and failure feedback. Switching files unmounts the previous player. No autoplay or automatic external embed is used. `MediaStrip` renders type-aware thumbnail content for grids; the host grid retains its keyboard and editing contract. Compact gallery removal uses the actions menu so controls fit narrow tiles.

All shared components, styles and the catalog specimen are mirrored in Factory. Feature CSS only handles layout. The grid's default loading overlay is unchanged.

Shopify's reader retains video renditions and 3D original-file URLs. Source contracts were checked against the official [Video documentation](https://shopify.dev/docs/api/admin-graphql/latest/objects/Video) and [Model3d documentation](https://shopify.dev/docs/api/admin-graphql/latest/objects/Model3d).

## Verification

The isolated fixture at `http://127.0.0.1:3167` mounts the production column, editor and linked Shopify media dialog. Its in-memory writes do not modify a real product or channel.

- Browser: parent and unlisted-variant reads on the actual Shopify editor; no real product writes.
- Browser fixture: native video loaded with `readyState=4`, `autoplay=false`, and played with Space; missing video showed a recovery message and original link.
- Browser fixture: keyboard reorder, save and reopen preserved Italian alt text and transcript; French Canadian text saved for a future channel/store/market stayed out of another store's gallery.
- Browser fixture: removal moved focus to the next preview; stale saves preserved the local draft and displayed a reload instruction; cancel protected unsaved changes.
- Browser fixture: dark gallery at 390 px and 320 px had no clipped tile actions or horizontal overflow inside the dialog; desktop and narrow image/video layouts were inspected.
- Unit checks cover locale resolution, explicit empty overrides, preservation of unrelated localized content, malformed data, URL handling, unknown media types, store/listing isolation, stale writes, unavailable assets, unpublished listing creation, permissions, native Shopify source preservation, and existing sheet regressions.
- Scoped Web/API/Factory types, token parity, CSS parsing, and the AG Grid import boundary were checked.

Storage-provider upload and live channel publication were not exercised against real accounts. This work does not claim a formal WCAG AAA audit of the application or of user-supplied video content.

Run the fixture with `node docs/audits/2026-09-10-product-media/browser-fixture/server.mjs`.


## Media cell follow-up

The shared/channel draft column now uses native AG cell focus, Enter/F2, double-click (including the fill corner), typed copy/paste, and vertical fill. Thumbnails reorder their own gallery without initiating a grid range drag; a click or completed drag returns keyboard focus to the cell. Gallery edits use quiet sheet refreshes, preserving selection and scroll. SaveReporter receives pending/success/failure events for cell writes. Failed operations retain the last confirmed gallery and keep a cell error until retried or reviewed through a subsequent gallery save.

Transfers encode the exact source product, store/listing/alias, market, language and visible media snapshot. The API rechecks both revisions in a serializable transaction, preserves ordered images/videos/captions/transcripts, reuses or creates product-library references, and preserves other stores and language fallbacks. It does not delete source or target files. Product-image cleanup checks other product, listing and media-library references before removing shared uploaded bytes. Revision hashing is independent of JSON key order.

`CellAction` standardizes the pencil layout and captures its mousedown before the grid can start a range gesture. `MediaStrip` optionally supports local thumbnail drag. The Shopify information grid uses these same controls and supports in-cell reorder with its existing draft undo/redo. Its legacy linked-product attachment API still supports reordering only: copying attachments between different linked Shopify products remains unavailable and the UI now explains that directly. Shared/channel gallery transfers remain Nexus drafts; live publication adapters are outside this follow-up.

Portal hints have one tooltip owner, no competing native thumbnail titles, no drag hover, an 8px pointer bridge, Escape dismissal, viewport clamping, long-label wrapping, and stronger secondary text contrast. Reusable components, styles, tokens and catalog guidance are mirrored into Factory. Factory has no grid adapter, so the Web-only corner-open fix has no Factory file.

Validation: 70 focused tests (34 API, 31 Web, 5 shared), scoped types for both production sheets, Shopify information, Web/Factory catalog and API routes, both token checks, CSS parse and AG import-boundary checks. Browser checks used the isolated 3167 fixture and the existing 3144 Shopify demo: native downward fill saved two galleries while retaining selection, video-first thumbnail drag saved and reopened correctly, stale saves retained confirmed order and a cell error, Enter/F2/body/corner double-click used the same editor, view-only cells removed drag affordances, Shopify reorder/undo preserved the draft, pencil close returned cell focus without a stuck range, tooltip pointer/Escape behavior, 390px tooltip fit, and a 320px dark dialog with no internal horizontal overflow. Clipboard serialization and import are covered by focused tests; the browser automation virtual clipboard did not capture AG's navigator.clipboard copy, so a full OS clipboard round-trip is not claimed.

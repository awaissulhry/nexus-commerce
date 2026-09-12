# eBay Media: common photos, variation focus and Nexus sizing

Product Studio → eBay → Media uses a gallery editor composed from the Nexus design system. Common photos, variation groups, previews and saves follow the selected listing alias, account and market. The latest refinement gives photos more room, keeps listing context visible and opens supporting tools on demand.

## Workspace refinement

- A compact Images header keeps the alias selector, account/market, draft-only notice, save state and Save draft action visible while the image area scrolls. The existing Media sub-sidebar entry remains the destination.
- Common photos open first. Variation navigation uses passive thumbnails, counts, explicit No photos labels and search above six groups. Only the long group list scrolls; its controls stay visible. On narrow screens, variation navigation opens through a Disclosure; choosing a group closes it and focuses that gallery's heading.
- Add photos opens the shared product library as a modal picker. On sufficiently wide workspaces it can remain pinned beside the canvas. Pinning/unpinning preserves the current search and selection; changing gallery resets pending source choices. The destination and remaining capacity are explicit. Over-capacity selections are refused before assignment and never trimmed.
- Preview and detailed Review open in dialogs. Save-blocking errors remain on the editor, and the Review count includes missing variation sets. Preview owns its scrolling inside the full-size DS media dialog, including long lists of common/variation photos.
- The DS PressableRow gained a decorative leading slot; existing compact Thumbnail density is used for gallery navigation. Embedded Drawer header text wraps without displacing Close. Modal owns its semantic text color, including plain footer content. Shared changes, catalog examples and documentation are mirrored in Factory; no control-size overrides were introduced.

### Refinement verification

The isolated browser fixture contains 80 source photos, 24 common photos, 32 variation groups and three listing choices. No production catalog or live listing was changed.

- 1,630 Web Studio/formula-editor tests and 20 API Media/destination-axis tests passed; one optional browser fixture was skipped in the API regression run. Web, API and Factory type checks passed.
- Both generated token checks, Web token guard, DS CSS parsing and design conformance passed. Factory retains 54 unrelated legacy platform-token aliases in `styles/patterns.css`.
- Browser checks covered search for the last of 32 groups, adding a photo through the pinned library, retained search/selection when pinning, saving/reloading, the independent Winter cover and primary Size option, keep-editing/discard alias navigation, refusal of 13 photos in a 12-photo variation set, and the full 24-photo common-gallery state.
- Nested photo inspection closes with Escape while keeping the source picker open; closing that picker restores the editor. Mobile variation selection reaches its gallery. Desktop and real 390px light/dark layouts were inspected. The 390px page and document widths match; the 350px picker/preview has no horizontal overflow, and the long preview content scrolls internally.
- Desktop action buttons remain 32px and media toolbar actions 28px. Narrow layouts use the existing 28px ToolbarButton for Preview/Review and the standard text-only Button for Save draft. Selector height remains 35.5px with 13px text. These targeted checks do not establish full WCAG AAA certification. Browser file upload remains unverified; upload transport behavior was not changed.

Evidence: [desktop dark](../output/ebay-media/refinement-desktop-dark.png), [desktop light](../output/ebay-media/refinement-desktop-light.png), [390px picker dark](../output/ebay-media/refinement-mobile-picker-dark.png), [390px preview light](../output/ebay-media/refinement-mobile-preview-light.png). Run the opt-in API fixture with `NEXUS_EBAY_MEDIA_BROWSER=1 NEXUS_EBAY_MEDIA_LARGE=1` for this dataset. The existing responsive fixture hosts the actual Studio route at 390px.

## Behavior

- **Cover & common photos** is always the first gallery. Its first image is the default cover. Common images are independent of the variation sets and remain visible as a cover/count summary while editing a variation.
- **Preview** starts with the common cover. Selecting a variation focuses its first assigned photo while retaining the common set; a variation without photos shows an explicit missing-photo message and falls back to the common cover. Thumbnail inspection does not change assignments. This models [eBay's documented common and variation photo associations](https://developer.ebay.com/api-docs/user-guides/static/trading-user-guide/variations.html), not its live page layout.
- The listing selector loads the primary listing and active aliases for the current product, account and market. The account name, market and alias remain explicit above the editor. The selection is part of the Studio URL.
- Grouping, gallery assignments, copy sources, image previews, review and save state all follow the selected listing. Switching destinations remounts the editor; pending operations block navigation and unsaved changes require a discard decision.
- Group options come from the family-axis resolver for that exact account and alias. A listing's variation theme overrides the product default. English category metadata and the existing eBay display-name dictionary label fields without renaming their stored addresses. Custom names without English metadata remain verbatim rather than receiving invented translations. Variation values remain unchanged.
- Loading, changing destination, reloading and returning focus refresh the current context. Source refreshes also refresh axis labels and available groups. Changed variation evidence causes a revision conflict before saving; dirty edits remain visible. Read sequencing prevents earlier refreshes from replacing a later save.
- Sources are shared by the product; galleries are listing drafts. Images can be reused, reordered, copied between galleries or removed without deleting their source. Uploads persist immediately and are clearly separate from **Save draft**.
- **Review** identifies the selected alias/account/market and distinguishes saved drafts from unavailable live evidence. Unknown dimensions, missing covers, inactive groups and other assignments are explicit.

## Storage and honesty boundaries

`GET/PUT /api/products/:productId/images-workspace/ebay` validates the eBay destination before accessing gallery data. Reads require `products.view`; writes require `products.images.edit`. A missing selection resolves only an unambiguous primary listing. Without one, the operator must select an available alias; saving never chooses an arbitrary alias.

Each draft lives at `ChannelListing.platformAttributes._mediaGalleryDraft` with a versioned, validated JSON shape. Saves atomically update only the selected listing's metadata and increment its optimistic version. Unrelated metadata, product preferences, shared `ListingImage` assignments, publication evidence, other aliases, markets and accounts are retained. The source library remains product-wide. No schema migration is required.

Initial images use the selected listing's saved `imageUrls` when present, including an explicitly empty gallery. Otherwise shared eBay assignments provide starting images. Saving creates an independent draft even when the initial order is unchanged. A saved draft no longer follows changes to shared gallery assignments.

The revision binds product, account, market, listing, observed listing attributes/version, inherited assignments when relevant, and resolved variation evidence. Changing a display label alone does not change gallery identity or invalidate the revision. Serializable transactions and compare-and-swap writes refuse overlapping updates; alias activity is rechecked inside the transaction. Invalid saved drafts are preserved and refused rather than silently replaced. Validation rejects foreign image IDs, duplicate galleries/URLs, unusable URLs, excess images and invented variation values.

A disconnected or unreadable write reports an unknown outcome and requires reconciliation. Responses must pass the runtime schema and match the requested product, listing, account and market.

**Publishing these listing drafts is unavailable.** Existing publishers do not consume this draft key. Saving does not update eBay, change legacy publisher inputs or verify buyer-facing images. Production data and live eBay listings were not changed during this work. Web, API and the built shared package must ship together; deployment was not performed.

Draft validation now allows 24 common photos and 12 photos per variation value. It refuses excess images without trimming. These match the general [listing photo allowance](https://www.ebay.com/help/selling/adding-pictures-listings/adding-pictures-listings?id=4148) and [variation picture-set limit](https://developer.ebay.com/devzone/xml/docs/Reference/eBay/types/VariationSpecificPictureSetType.html); category exceptions require review before publication. The uploader's 10 MB JPEG/PNG/WebP restriction is an application choice. Stored dimensions support only the documented 500-pixel longest-side check, not image-content or remote-access certification. Sources checked during the rebuild: [eBay image API guidance](https://developer.ebay.com/api-docs/sell/static/inventory/managing-image-media.html) and [picture policy](https://www.ebay.com/help/listing-policies/policies/picture-policy?id=4370).

## Design-system correction

The initial Media wrapper forced controls to 44px. The separate `nds-readable` wrapper repeated that mistake and also forced 18px input text. Both overrides are removed. Readability changes contrast and focus only; size props retain their normal Nexus meaning. Media uses the shared PageHeader, aligned action rows, 32px icon/text actions, standard 28px toolbar actions and 35.5px selectors with 13px text. Feature CSS controls layout and domain content.

Shared component and style changes are mirrored to Factory. The Media catalog now compares standard and readable controls with identical props. DESIGN.md records the density contract; the catalog, changelog and DS-GAPS entries describe the correction.

## Earlier common-gallery verification

- Web Studio and DS formula-editor regressions: 105 suites, 1,630 tests passed. The first attempt hit a sandbox-only local-listener error; the authorized rerun passed.
- Shared photo model: 12 tests passed. API Media and listing-axis tests: 20 passed, 1 optional browser fixture skipped. Coverage includes 24 common photos saved independently of variation photos, atomic refusal of 13 variation photos, cover focus, missing variation photos and preservation of assignments.
- Final Web, API and Factory type checks passed. Generated token checks passed in both apps. Web token guard (165 files), DS CSS parsing (14 files) and design conformance passed.
- Browser verification used the actual Studio route and an isolated transactional API fixture. Common Front/Side photos and a separate Blu photo survived saving and reloading. Preview focused Front initially, Blue on Blu selection and Front with an explicit warning for empty Rosso. Keyboard reordering, original-image inspection, Escape and opener-focus restoration passed.
- Desktop and real 390px iframe viewports were inspected in light/dark. The editor and preview had no document or Media-container horizontal overflow. Action rows align; buttons retain their DS sizes. Standard and readable catalog controls have identical heights and font sizes in both themes: default text Button 30.30px, small Button 28px, Input 33.5px and Select 35.5px. These targeted checks do not establish full WCAG AAA certification.
- Factory's token guard reports 54 unrelated legacy aliases in `styles/patterns.css`. Browser file upload remains unverified because Chrome's extension rejected file access in the earlier rebuild; this follow-up does not change upload behavior.

Screenshots use synthetic bottle images: [desktop common preview](../output/ebay-media/common-photos-desktop-dark.png), [390px light fixture](../output/ebay-media/common-photos-mobile-light.png), [390px dark fixture](../output/ebay-media/common-photos-mobile-dark.png). The responsive fixture is development-only and requires `NEXT_DEV_STUB_PROXY=http://127.0.0.1:4117`; it is unavailable in production.

## Earlier alias verification

- 51 API tests passed across the Media route, family-axis resolver and destination resolver; 2 optional tests skipped. Coverage includes alias isolation, English metadata, changing group values, listing theme precedence, conflicts, malformed drafts, explicit empty galleries, preserved source assignments and RBAC.
- 10 shared gallery tests and 7 transport tests passed. Transport rejects successful responses for the wrong listing, account or market.
- Web and API type checks passed on the final implementation. An earlier API check reported unrelated mapping-service type errors; those were absent on the final check.
- Generated Web tokens, the Web token guard (165 files) and design conformance passed. The alias change composed existing `Field` and `Select` primitives.
- Browser checks used the actual Studio route against an isolated transactional API fixture. Primary `Size` and alias `Color` options loaded independently. `Color: Blu` retained the original value `Blu`. Reorder, save, reload and gallery-copy checks passed; the primary kept its original cover after alias edits. Both keep-editing and discard-and-switch paths passed, and discarded edits did not replace the saved alias gallery.
- The earlier 44px sizing measurements are superseded by the density correction and browser measurements above.

The preceding rebuild verified 1,315 Studio tests and introduced the mirrored Media components. The broader current regression and current guard results are recorded above. Work remains local and uncommitted; live eBay publication was not performed.

# Images (Media) page rebuild — research record

Date: 2026-09-27. Branch `feat/images-studio-rebuild`, worktree `/private/tmp/nexus-images-studio`, base `972463c08`.
Read-only research: code, docs and public channel documentation. Nothing was changed, nothing touched a database
or a channel. The plan that uses these facts is [PLAN.md](PLAN.md).

Path prefixes: `S/` = `apps/web/src/app/products/[id]/edit/_studio/`, `API/` = `apps/api/src/`,
`SH/` = `packages/shared/`, `DB` = `packages/database/prisma/schema.prisma`.

## Summary

1. **The page shows one destination at a time.** Every channel, market, account and alias is its own URL and a
   full remount. Putting one photo set on every channel takes about 60 clicks and 5+ page loads. There is no
   cross-channel action in the live code.
2. **A listing's photos live in up to five stores**, each with its own shape, and the Images page and the
   Information sheet's "Product media" column read different ones. An operator can edit two surfaces that
   disagree, and only one of them ships.
3. **Only one store is keyed per account and alias** (JSON inside `ChannelListing.platformAttributes`). The old
   `ListingImage` table has no account, listing or alias column.
4. **Only master library writes send a live update.** Channel saves, sheet-column saves and publishes emit
   nothing, and no sheet or media surface listens.
5. **Etsy has no image editing and no image publisher in use. The old Shopify image publisher is a stub that always
   fails.** Two eBay paths always use the primary account.
6. **Channel rules that shape the design:** eBay varies photos by ONE aspect, with a shared gallery (≤24, first =
   search photo) plus one set per value (≤12); eBay images belong to the SKU/group per account, not to a market.
   Amazon images are global per ASIN (one set for all markets). Shopify allows one image per variant. Etsy allows 20
   photos and one variation photo per option value.

---

## A. The page today (frontend)

### A1. Routing and scope
- The tab mounts at `S/StudioTabHost.tsx:53` (`images: ImagesTabRoute`); the sidebar calls it **Media**
  (`S/navigation.tsx:16`). It is re-keyed on `[product, tab, scope, market, locale, accountId, listingId]`
  (`StudioTabHost.tsx:75`): every scope change unmounts and refetches.
- `S/images/ImagesTabRoute.tsx:20-27`: EBAY → `EbayMediaWorkspace`, AMAZON → `AmazonMediaWorkspace`,
  SHOPIFY → `ShopifyContentWorkspace`, everything else (Master, ETSY, WOOCOMMERCE) → `ImagesTab`.
- **Bug:** Etsy and WooCommerce land in `ImagesTab`, show a "Shared gallery assets" banner and then a placeholder
  that talks about Shopify (`ImagesTab.tsx:101, 154-163`).
- Scope state is URL-driven (`S/contracts.tsx:131-162`). Switching market clears the chosen listing (`:866`), so
  an alias choice is lost on every market switch. Switching account clears it too (`:878`).
- Aliases are picked with a `<Select>` inside each workspace (`EbayMediaWorkspace.tsx:225-228`,
  `AmazonMediaWorkspace.tsx:243-245`). The scope bar has no alias picker.

### A2. Master gallery (`ImagesTab.tsx`, `master/*`)
- Upload (sequential, dedup gate), select, shift-range, set hero, reorder (optimistic + rollback), delete,
  "Apply to N SKUs" (sends explicit `append`; the server default is a destructive `replace`), DAM library import,
  AI lifestyle scene, find duplicates, viewer (alt text, type, crop/rotate → new derived image, push to DAM),
  videos. Writes are immediate, no Save button.
- The header copy says "Every channel cascades from this set" (`MasterGallery.tsx:314,320`). **Not true** for the
  new Amazon and eBay workspaces: they seed from listing data and freeze once saved.

### A3. eBay workspace (`ebay/*`, `SH/ebay-media.ts`)
- Model: `{axis, galleries:[{axis, value, assetIds}]}`. The gallery with `axis=null` is "Cover & common photos";
  its first photo is the cover. Other galleries = one set per value of one chosen axis.
- Limits: 24 common, 12 per variation (`SH/ebay-media.ts:4-5`), refused not trimmed.
- **Repeat rule flipped:** the new code allows the same photo in Common and in a colour set ("Reuse between
  galleries is intentional", `SH/ebay-media.ts:104`). The earlier rule (June 2026, P5) was "every photo lives in
  exactly one bucket" because eBay shows it twice.
- Stored at `ChannelListing.platformAttributes._mediaGalleryDraft` per listing (so per account and alias). Seeds
  from the listing's `imageUrls` or legacy `ListingImage`, **not** from the master gallery order.
- Save: `PUT {expectedRevision, draft}`, SHA-256 revision, Serializable transaction, 409 → "Reload required".
- The UI says publishing is unavailable. **That is out of date (verified 2026-09-27):**
  `API/services/pim/studio-publication-ebay.ts:269-281` reads `_mediaGalleryDraft` when the studio Publish runs
  (common → `PictureDetails`, value sets → `VariationSpecificPictureSet`).

### A4. Amazon workspace (`amazon/*`, `SH/amazon-media.ts`)
- Slots MAIN, PT01–PT08, SWCH; PS01–PS06 behind a toggle, exported as a Seller Central ZIP.
- Rows: "Common images" + one gallery per child SKU (grouped by an axis). A missing slot inherits from common.
- **Per market only** ("These images are not inherited by other markets", `:281`), stored on that market's root
  listing at `_amazonMediaWorkspace`. The "images are global per ASIN" warning required by PES.7 decision D1 is gone.
- Actions: add images, copy from market, apply to SKUs (fill/replace/inherit/clear), check Amazon, review and
  publish (`AmazonMediaRun`), export PS ZIP, save draft (revision CAS), 30 s poll.

### A5. Shopify (`shopify/*`)
- Part of a whole-family content document (`SH/shopify-content.ts`, stored at `_nexusContent`): assets (≤250),
  reusable image groups, assignments (family / option / exact variant) with priority and replace/append.
- Account only, `market=GLOBAL`, **no aliases**. Sync via "Review Shopify sync".

### A6. Dead or unreachable code
- `ImagesTab.tsx:45` hard-codes `publicationAvailable = false`: `CrossChannelPlanner`, `PublishHistory`,
  `ScheduleSurface`, `LocalPublishSettings` never render.
- `channel/amazon/*` (~2,700 lines) and `channel/ebay/*` (468 lines) can never render (the route catches AMAZON
  and EBAY first). `plan/`, `publish/`, `local/` likewise.
- The legacy tree `edit/tabs/images/**` (~17k lines) and `ProductEditClient` are unreachable (the edit route
  redirects to the studio).
- Still live: `record/` (used by `S/drawer/RecordDrawer.tsx`).

### A7. The "Product media" column (Information sheet)
- `S/media/productMediaColumn.tsx` + `ProductMediaDialog.tsx`, mounted on the master sheet and on every channel
  sheet, Etsy included. Cell = `MediaStrip` (drag reorder), copy/paste/fill-handle of whole galleries,
  Enter/F2 opens the dialog (library, upload, reorder, remove, alt text per language, captions, "Use inherited").
- Data: `GET/PUT /api/products/:id/product-media?scope&market&locale&accountId&listingId&aliasKey`.
  Master → `Product.localizedContent[locale]._productMedia`; channel → `_productMediaLocales[locale]`.
  Resolution: exact locale → `und` → shared → parent → library (`SH/product-media.ts:61-76`).
- **No sync with the Media tab:** no shared hook, cache or event; different stores on eBay and Amazon.
- The dialog labels an alias `Listing ${position+1}` instead of its label (`productMediaColumn.tsx:45`).
- Row and band thumbnails come from the `ProductImage` face picture, not from the saved gallery.

## B. Backend: stores and publishers

### B1. Stores
| Store | Keyed by | Written by | Read by |
|---|---|---|---|
| `ProductImage` (`DB:2498`) | product | master gallery, uploads | everything as the library |
| `ListingImage` (`DB:8787`) | product, variation, scope, platform, market (**no account, listing, alias**; no unique) | legacy tabs, eBay flat-file image modal | legacy Amazon feed, legacy eBay push, eBay flat file `image_1..6`, description themes |
| `_productMediaLocales` (per listing JSON) | listing (= account + alias) × locale | sheet column | sheet, studio publication (eBay children, Amazon fallback, Shopify, Etsy) |
| `_mediaGalleryDraft` (eBay JSON) | listing | eBay Media workspace | studio publication eBay (parent gallery + variation pictures) |
| `_amazonMediaWorkspace` (+ observations, active run) | market root listing | Amazon Media workspace | `AmazonMediaRun` worker; studio publication Amazon |
| `_nexusContent` (Shopify JSON) | listing | Shopify workspace | Shopify content sync |
| `imageUrls` / `attributes.*image_locator*` | listing | eBay spec column, workbook import; Amazon flat file | seeds for the eBay/Amazon workspaces; eBay publish fallback |

- Only `AmazonMediaRun` (`DB:8890`) among image tables carries `listingId` + `accountId`.
  `ChannelLiveImage`, `ChannelImagePublishJob`, `AmazonImageFeedJob`, `ScheduledImagePublish` have no account.
- `ListingImage.variationId` has an FK to the dead `ProductVariation` table, but publishers treat it as a child
  `Product.id` (not verified against live data).
- All image models are classified in `model-ownership.json` and covered by workspace RLS. Account restrictions do
  not apply to image tables (no account column).

### B2. Publish paths
- **Amazon, legacy feed** (`API/services/images/amazon-image-feed.service.ts`): `ListingImage` rows, 9-level
  cascade, exact-mirror, JSON_LISTINGS_FEED, default seller only. It refuses any market that has an
  `_amazonMediaWorkspace` (`:307-311`).
- **Amazon, media run** (`amazon-media-client.ts`, `amazon-media-publish.service.ts`): per account, market and
  listing; observe → diff → `VALIDATION_PREVIEW` → approve → PATCH through `gatewayFetch`. MAIN/PT/SWCH only; PS
  via ZIP. Worker every 30 s.
- **Amazon, studio publication** (`API/services/pim/studio-publication-amazon.ts:46,112-129`): uses
  `_amazonMediaWorkspace` if present, else `_productMediaLocales` (max 9).
- **eBay, legacy Inventory publish** (`ebay-inventory-image-publish.service.ts`): primary account only (`:168`),
  reads `ListingImage` ignoring market/account/alias, cap 12.
- **eBay, legacy Trading lane** (`ebay-shared-image-publish.service.ts`): `ReviseFixedPriceItem` with
  `PictureDetails` + `VariationSpecificPictureSet`, cap 12.
- **eBay, studio publication** (`studio-publication-ebay.ts`): per child `_productMediaLocales` → `imageUrls` →
  library (`:182-183`); parent `_mediaGalleryDraft` wins when present (`:269-281`). Cap 24 per set (does not
  match eBay's API limit of 12 per variation set). The publish review lists "Listing pictures" and
  "Variation pictures" as selectable fields (`studio-publication-ebay-changes.ts:92,134`), so a photos-only
  publish already works through the sparse selection.
- **Shopify:** legacy `publishShopifyImages` is a stub that always fails (`shopify-image-publish.service.ts:5-8`)
  but is still wired to the old tab, the scheduler and bulk. The real path is content sync:
  `fileCreate` → `productSet{files, variants[{file}]}`, `productVariantAppendMedia/DetachMedia`,
  `productReorderMedia` (`API/services/shopify/*`).
- **Etsy:** `uploadEtsyListingImage` / `deleteEtsyListingImage` exist (`API/services/etsy/listing-write.service.ts:99-150`)
  with no callers except a test. No variation-image support.
- `UploadSiteHostedPictures` is listed as a Trading write (`ebay-trading-api.service.ts:317`) but **nothing calls
  it** (only a comment in `channel-publish.service.ts:141`). eBay retires that call on 2026-09-30: no impact.

### B3. Live read-back and jobs
- Amazon `refreshAmazonLiveImages` (env seller); eBay `GetItem` with market hard-defaulted to IT; Shopify
  read-back needs env credentials that production does not have (`NO_CREDS`).
- `scheduled-image-publish` cron is off unless `NEXUS_ENABLE_SCHEDULED_IMAGE_PUBLISH=1`.
- `IMAGE_REPUBLISH` outbound rows from `cascade-image-republish.service.ts` have no consumer.

### B4. Upload pipeline
- `POST /products/:id/images`: sha256 exact reuse; aHash ≤ 6 AND dhash256 ≤ 26 → 409 near-duplicate unless
  `force`; uploads to Shopify Files when a default media store resolves, else Cloudinary; stores width, height,
  bytes, mime; `sortOrder` = max + 1. Videos up to 200 MB.
- Three role vocabularies coexist: `ProductImage.type`, `ImageRole` enum, lowercase `AssetUsage.role`.

## C. Aliases, accounts, markets, live sync

### C1. Aliases
- `ProductListingAlias` (`DB:1866-1911`) on the family root: channel, marketplace, account, `label`, `position`
  (primary = 0 has no alias row), `status` ACTIVE/ARCHIVED, `adoptedFromProductId`.
- `ChannelListing.aliasId` + `aliasKey` (`''` = primary) are part of both unique keys; always written together.
- An alias = N listings of one product on one channel × market × account ("different titles, photo sets, price
  points competing in search"). A new alias starts as DRAFT rows that inherit everything.
- 22 old `EBAY_LISTING_SHELL` phantom products are the pre-alias workaround. The adoption script
  (`apps/api/scripts/pes5-adopt-shells.mts`) **does not move their images** (they sit in `ListingImage` on the
  shell product). The eBay flat file still creates new shells (`ebay-flat-file-create.service.ts:220-232`).
- Inheritance today: listing locale → listing neutral → shared product → parent → library.
  **There is no "primary listing → alias" layer.**
- No alias SKU derivation exists. Amazon Media refuses aliases without their own `sellerSku`. eBay studio
  publication is keyed by SKU: two aliases on the same eBay account need distinct SKUs on the Inventory path.

### C2. Accounts and markets
- Accounts attach per channel to every market of that channel (eBay connections have `marketplace = null`).
- The default account is chosen only when there is one account or one primary; else "Choose an account".
- **Precedent for all coordinates on one screen:** the Matrix page (`GET /studio/matrix`, `coordinates[]` with
  alias and account; on the shared scope the channel chips FILTER instead of navigating) —
  `docs/2026-09-13-matrix-page-design.md` §3.2–3.6.

### C3. Live updates
- One push path exists: SSE `GET /api/listings/events` → `useListingEvents` → BroadcastChannel
  `nexus:invalidations` → `useInvalidationChannel`. Payload schemas in `packages/events/catalog.ts` are strict.
- Only `ProductImage` library routes emit (`IMAGES_UPDATED` → `product.updated`). Media saves, channel drafts,
  bulk-save and publishes emit nothing. The studio frame's stream feeds only the readiness chips; no sheet adapter
  or media surface subscribes. Local dev has streams off by default (`dev-stream-gate.ts`).
- The product-media revision hashes whole product/listing rows and saves bump `Product.version` /
  `ChannelListing.version`, so a media save and a sheet cell edit on the same row conflict (false 409s).

### C4. Files and flat files
- PSIE export does not carry the Product media column. eBay workbook `Image N` writes per-alias `imageUrls`.
- eBay flat file `image_1..6` is a live mirror of `ListingImage` and its image modal writes `ListingImage`.
- Amazon flat file keeps image locators in product-type attributes.

## D. Channel rules (public documentation, 2026-09-27)

### D1. eBay
- Inventory API: images on `inventoryItem.product.imageUrls` (per SKU) and `inventoryItemGroup.imageUrls` (group).
  **Neither is per marketplace** — every offer of a SKU shows the same photos. Different photos per market or per
  alias need different SKUs.
- One aspect varies pictures (`variesBy.aspectsImageVariesBy`; Trading allows one `Pictures` node with one
  `VariationSpecificName`).
- Counts: up to 24 pictures per listing; **up to 12 per inventory item in a group** / per
  `VariationSpecificPictureSet`. eBay's seller help says 24 per variation in its own UI; design to 24/12 and keep
  them as configuration.
- First shared picture = gallery/search image; first picture of a value's set = that value's image when a buyer
  filters or selects it. A value without pictures shows "no picture available". eBay recommends shared pictures
  that show several variations.
- Updates are full replace (GET then PUT); a live change revises the listing (250 revisions per day). A group PUT
  that leaves out a SKU removes that variation. A listing created with the Inventory API cannot be revised with
  the Trading API.
- Trading: `PictureDetails.PictureURL` ≤ 24, HTTPS, total length of all URLs ≤ 3975 characters, no mixing of eBay
  (EPS) and self-hosted URLs in one listing. Self-hosted pictures are copied to EPS **except variation pictures**;
  after a sale, sets with self-hosted pictures cannot change. CMYK images are not shown.
- Media API `createImageFromUrl` / `createImageFromFile` uploads to EPS (12 MB, JPG/PNG/GIF/WEBP/HEIC/AVIF…,
  50 POST per 5 s). Unused EPS images expire. `UploadSiteHostedPictures` is decommissioned 2026-09-30.
- Picture policy: ≥ 500 px longest side (1600 recommended), ≤ 12 MB, no borders/text/watermarks.
- **Duplicate listings policy:** more than one fixed-price listing of an identical item by the same seller at the
  same time is not allowed (different eBay sites are allowed). Relevant to aliases.
- Sources: developer.ebay.com Inventory/Trading/Media references; ebay.com help 4370, 4148, 4150, 4255.

### D2. Amazon
- Attributes: `main_product_image_locator`, `other_product_image_locator_1..8`, `swatch_product_image_locator`,
  `image_locator_ps01..06` (depends on product type and market). Other Seller Central slots are not in the API.
- **Images are global per ASIN** even with a `marketplace_id` selector (Listings FAQ; issue #4920: a DE update
  changed NL). Country-specific images exist only as a brand-owner Seller Central tool, not guaranteed.
- Every child needs its own MAIN showing its colour; parent images are not shown.
- MAIN: pure white, 85% fill, no props. 500–10,000 px; ≥ 1000 px enables zoom. JPEG/PNG/TIFF/GIF.
- Delete needs the selector values. Up to 24 h to appear; Amazon may pick another seller's image.
- Third-party URLs are allowed if publicly reachable; content-addressed URLs are safest.

### D3. Shopify
- ≤ 250 media per product. **Exactly one image per variant**, which must be product media.
- `productCreateMedia` is deprecated; use `fileCreate` + `productSet`/`productUpdate`. `productSet` list fields are
  the full truth (anything missing is deleted). Reuse files by id. Position 0 = featured image. 20 MB, 20 MP.

### D4. Etsy
- ≤ 20 images and 2 videos per listing. Binary upload only (Etsy does not fetch URLs). `rank` 1 = main.
- `updateVariationImages`: one property, one image per option value, ≤ 20 options, overwrites all.
- No transparency (transparent PNG shows black). First photo ≥ 635 px, landscape or square.

### D5. Localized photos per market (checked 2026-09-27, after the Owner's question)
- **Amazon, by API:** no. Images belong to the ASIN in every market (D2 above). The current Amazon draft already
  tags each image with a language (`{assetId, language}`, `zxx` = no text; `SH/amazon-media.ts:14,70`).
- **Amazon, by hand:** Seller Central Image Manager → "Country-Specific Upload" lets brand owners show different
  images for the same ASIN in one country (e.g. native-language infographics); ZIP up to 1 GB / 1,000 images;
  no API is documented. Sources: [Amazon seller forum](https://sellercentral.amazon.com/seller-forums/discussions/t/789215ef-1a38-43f1-a925-abf743794687),
  [eCommerce Nurse](https://ecommercenurse.com/localising-product-images-on-vendor-and-seller-central/),
  [eComEngine](https://www.ecomengine.com/blog/amazon-country-specific-upload).
- **Amazon A+ Content API:** `createContentDocument` takes a `marketplaceId`, and the document has a `locale`;
  images are added through upload destinations. So A+ can carry localized size charts and infographics per market
  by API (Brand Registry). Sources: [createContentDocument](https://developer-docs.amazon.com/sp-api/reference/createcontentdocument),
  [A+ Content API guide](https://developer-docs.amazon.com/sp-api/docs/a-plus-content-api-use-case-guide).
- **eBay:** each market is its own listing, so each can have its own photos — on the Inventory API only when the
  market has its own SKU (images belong to the inventory item).
- **Shopify:** "media localization is currently only supported for theme sections & metafield file references.
  Product media localization is not yet supported." ([Shopify changelog, 2022-12-08](https://changelog.shopify.com/posts/online-store-media-localizable-to-different-languages-and-markets));
  2026 guides still use apps for per-market product images ([newcraft.dev](https://newcraft.dev/posts/how-to-override-product-images-per-shopify-market/)).
  Alt text is translatable per locale.
- **Etsy:** one image set per listing for all languages.

## E. Industry patterns worth copying
1. One library, many links, no copies; per-channel cached uploads (EPS URL per eBay account, Shopify file id,
   Etsy image id).
2. File-name rules that link photos to products/values with a preview before linking (Akeneo naming conventions,
   Plytix auto-link, Amazon `ASIN.MAIN.jpg`).
3. One "photos vary by" setting per family: a shared set plus one set per value (eBay, Etsy, Shopify, Akeneo
   colour-level pictures).
4. Matrix editor: rows = values, columns = ordered positions, drag-and-drop, bulk assign (Shopify variant picker).
5. Inheritance with visible overrides and "reset to inherited" (Linnworks per-channel images, Akeneo scopes).
6. Channel slot view + buyer preview (search thumbnail; what shows when "Black" is selected).
7. Readiness check per channel before publishing (Salsify).
8. Honest publish status: submitted vs live, a diff of what changes, revisions used.

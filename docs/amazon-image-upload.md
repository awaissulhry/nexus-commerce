# Amazon image upload — operator reference

How Nexus ships product images to Amazon, what gets validated, and how to use the ZIP fallback for Seller Central's bulk-upload page.

Source-of-truth: Amazon's spec at <https://sellercentral.amazon.it/help/hub/reference/G1881>.

## The two paths

| Path | When to use | Where to start |
|---|---|---|
| **Direct publish** (preferred) | Normal day-to-day. Nexus → SP-API JSON_LISTINGS_FEED. | Product edit → Images tab → Amazon → marketplace tab → **Publish** |
| **ZIP export → Seller Central bulk upload** | SP-API down, sandbox testing, or manual review before publish | Product edit → Images tab → Amazon → **Export ZIP** menu |

Both paths use the **same resolver** under the hood, so what you see in the matrix is exactly what either path will send.

## Resolver cascade (9 levels)

For each (ASIN, slot) cell, the resolver picks the first match in this order:

| # | Scope | What it means |
|---|---|---|
| 1 | exact variant × marketplace | "Giallo ASIN's MAIN on Amazon IT" |
| 2 | exact variant × all-Amazon | "Giallo ASIN's MAIN on all Amazon markets" |
| 3 | exact variant × global | "Giallo ASIN's MAIN on every channel" |
| 4 | group × marketplace | "Color=Giallo's MAIN on Amazon IT" |
| 5 | group × all-Amazon | "Color=Giallo's MAIN on all Amazon" |
| 6 | group × global | "Color=Giallo's MAIN everywhere" |
| 7 | product × marketplace | "Product MAIN on Amazon IT" |
| 8 | product × all-Amazon | "Product MAIN on all Amazon" |
| 9 | product × global | "Master gallery MAIN" |

This is implemented in `apps/api/src/services/images/amazon-image-feed.service.ts:resolveSlot`. The pre-publish preview, the validation gate, the publisher, and the ZIP exporter all call the same function.

## Pre-publish preview

Click **Preview** in the Amazon tab → modal opens showing:

- One row per child ASIN with its `variantAttributes` (Color, Size, …)
- One column per slot (MAIN, PT01..PT08, SWCH)
- Each cell = thumbnail of the image that would publish
- Cell border colour = source: solid blue = explicit variant override, light grey = inherited from group / product, dashed = empty
- Per-row coverage chip (e.g. "9/10 slots")
- Headline: "18/18 with ASIN · 17/18 with MAIN"

**Empty MAIN on a real ASIN colours the row red** — Amazon rejects listings without MAIN, so this is catastrophic.

Click any cell → drill-down panel shows the resolver level that won + the underlying `listingImageId`.

## Validation gate (IA.4)

Before submission, Nexus runs a hard validation pass. **Hard fails block publish**; soft warnings are informational.

### Hard fails

| Code | Why |
|---|---|
| `MAIN_MISSING` | ASIN has no MAIN image. Amazon rejects the entire listing. |
| `IMAGE_TOO_SMALL` | Image's long edge < 1000 px. Amazon spec. (`PLATFORM_RULES.AMAZON.minDimensionPx`) |
| `URL_INVALID` | Resolved image has no URL or a malformed URL. |

When any hard fail exists, the publish endpoint returns 422 with the issue list. The Preview modal's **Publish** button disables itself. To override (e.g. you know Amazon's rules changed and our validator is stale), the API accepts `force: true` — but there's no FE button for this; intentional friction.

### Soft warnings

| Code | What it means |
|---|---|
| `SWCH_MISSING_ON_COLOR` | Color variant has no SWCH slot filled. UI on Amazon's color picker shows less rich previews. |
| `TOO_FEW_IMAGES` | ASIN has fewer than 3 filled slots. Listing quality suffers but submission isn't blocked. |
| `MAIN_NOT_WHITE_BG` | AI vision flagged the MAIN as non-white-background. |

## Publish flow (direct)

1. **Preview** — operator opens the preview modal, scans coverage + validation.
2. **Publish** — fires `POST /amazon-images/publish` with `{ marketplace, activeAxis }`. Validation runs server-side; 422 returns the issue list.
3. **Feed submission** — service builds JSON_LISTINGS_FEED, uploads via SP-API, stores `AmazonImageFeedJob{ status: PENDING/SUBMITTING }`.
4. **Polling** — every ~30s Nexus polls SP-API for feed status. Operator can hit **Refresh from Amazon** to force an immediate poll.
5. **Done** — `pollAndUpdateFeedJob` fetches Amazon's processing report, parses per-SKU outcomes, stores them on `AmazonImageFeedJob.resultSummary.perSku`. Each `ListingImage` row gets `publishStatus` updated to `PUBLISHED` or `ERROR` based on its row's outcome.
6. **Receipt** — Publish history row expands to show each SKU's `accepted`/`rejected` + Amazon's verbatim error code + message.

## Retry-rejected-only (IA.6)

When a feed finishes with some rejections, the receipt drill-down shows a **Retry N rejected** button. It calls the retry endpoint with `{ rejectedOnly: true }`. The retry path:

- Reads `resultSummary.perSku`
- Filters to `!accepted` rows
- Resolves their SKUs → variantIds
- Calls `submitAmazonImageFeed({ ..., variantIds })` — accepted ASINs stay untouched

Accepted ASINs never get re-hammered, so Amazon's throttle stays happy. The original DONE row stays as the historical record.

## Stale detection (IA.5)

When you update a master image, IE.6's effective-URL resolver picks up the new URL automatically for any `ListingImage` linked via `sourceProductImageId`. But Amazon still has the *old* bytes until the next publish runs.

The **Amazon panel shows a banner** above the matrix when stale rows exist:

> ⚠ 3 ASINs have stale images on Amazon IT — master images updated since last publish (8 rows). [Re-publish stale]

Click **Re-publish stale** → calls the publish endpoint with `variantIds` set to just the stale variants. Targeted re-sync, not a full feed.

## ZIP fallback

For times when SP-API is down, you want a sanity check, or you prefer Seller Central's UI:

1. **Export ZIP** menu in the publish bar → pick a marketplace (or "All markets")
2. Backend resolves the same cascade as a publish would
3. Fetches each image (15s timeout per file), packs into a ZIP
4. File names: `{ASIN}.{SLOT}.{ext}` — matches Amazon's bulk-upload page expectation
5. Multi-market mode: per-marketplace folders `IT/B0XXX.MAIN.jpg`, `DE/...` etc

Validator runs first — ASINs with hard fails are **skipped** with a reason in the response toast:

> Downloaded 162 images · 8 fetch errors · 2 SKUs skipped (no ASIN) · 3 ASINs skipped (MAIN_MISSING)

### Uploading to Seller Central

1. Go to Seller Central → Inventory → **Manage Images** → bulk-upload tab
2. If single marketplace: drag the flat ZIP onto the page
3. If multi-market export: extract the ZIP, drag the relevant `IT/` (or `DE/` etc) folder. Seller Central operates on one marketplace at a time.
4. Amazon processes; check Manage Images status for per-ASIN results

### Filename convention

Default: `{ASIN}.{SLOT}.{ext}` — what Amazon's bulk-upload page documents.

Alternative `sku` template: `{SKU}.{SLOT}.{ext}` — useful when you want a human-readable archive for pre-publish photoshoot work. Not currently exposed in the FE; available via API body `{ filenameTemplate: 'sku' }` on the export endpoint.

### Slot codes (Amazon variant tags)

| Slot | What |
|---|---|
| `MAIN` | Hero. White background required. Aspect 1:1. |
| `PT01–PT08` | "Other view" gallery — up to 8. White background not required; lifestyle / detail / size chart fits here. |
| `SWCH` | Swatch — small color chip for variation listings. Optional but improves Amazon's color picker UX. |

## Common rejection codes Amazon returns

Surfaced verbatim on each rejected SKU's row in the receipt:

| Code (typical) | Operator action |
|---|---|
| `IMAGE_TOO_SMALL` | Re-upload at ≥ 1000px long edge |
| `INVALID_IMAGE_URL` | URL unreachable — check Cloudinary status |
| `WHITE_BACKGROUND_REQUIRED` | Replace MAIN with white-bg shot or run auto-enhance |
| `IMAGE_FORMAT_UNSUPPORTED` | Convert webp/heic → JPG (IE.8 will handle this automatically when it lands) |
| `DUPLICATE_IMAGE` | Same image hash used on multiple slots — replace one |

For codes not listed here, copy/paste the exact code into Amazon's seller forums or open a Seller Support case — Amazon's catalog of codes evolves and we don't try to mirror it locally.

## Schema reference

| Table | Why |
|---|---|
| `ProductImage` | Master gallery rows. Source of truth for URL + alt. `contentHash` / `perceptualHash` for IE.1 dedup. |
| `ListingImage` | Per-channel, per-variant, per-slot pointer. `sourceProductImageId` links back to master (IE.6 effective-URL). `altOverride` for per-row alt. |
| `AmazonImageFeedJob` | One row per JSON_LISTINGS_FEED submission. `resultSummary.perSku` carries the IA.3 receipt. |
| `ChannelLiveImage` | IE.4 read-replica of what's currently live on the channel. |

## Common operator workflows

### "I uploaded a new MAIN image — how do I get it on Amazon?"

1. Master gallery → upload (IE.1 dedups if it's a re-upload)
2. The new master propagates to every ListingImage that referenced the old one (IE.6 effective-URL)
3. **Stale banner appears** above the Amazon matrix (IA.5) — click **Re-publish stale** for targeted sync
4. Feed status polls; receipt shows what Amazon accepted

### "I want to set per-color MAIN images for all my color variants in one go"

1. Master gallery → upload the Black hero shot
2. Right-click the master thumbnail → **Apply to…** (IE.12)
3. Pick `Color = Black`, slot = MAIN, marketplace = All Markets
4. Preview count: "9 cells will be queued (9 new, 0 replacing existing)"
5. Save → preview the publish → publish

### "Why didn't ASIN B0XYZ get the new image I uploaded?"

1. Open the Publish History panel
2. Find the most recent Amazon publish for that marketplace
3. Expand the per-SKU receipt
4. Find the row — `accepted: true` means Amazon got it; check the URL in your browser
5. If `accepted: false`, the row shows Amazon's verbatim error code + message

### "I want to check what's currently live on Amazon without publishing"

1. Open the Amazon tab → **Live channel strip** at the top (IE.5)
2. Click **Refresh** on the marketplace row → fetches via SP-API `GetListingsItem`
3. Thumbnails show what Amazon is currently serving + timestamps
4. ⚠ flags on cells that don't match Nexus' intent
5. Click a flagged thumb → diff modal with side-by-side preview

## Validator + cascade + receipt cheat sheet

| Question | Where to look |
|---|---|
| "What will publish?" | **Preview** modal — per-ASIN × per-slot table |
| "Will Amazon accept it?" | **Validate** call runs inside Preview — issues banner at top |
| "Did Amazon accept it?" | **Publish History** → expand row → per-SKU receipt |
| "Is anything out of date?" | **Stale banner** above the matrix (auto-appears) |
| "Did my master swap propagate?" | Stale banner clears after `Re-publish stale` completes |

## Glossary

- **Slot** — Amazon's variant tag (MAIN, PT01..PT08, SWCH)
- **Group** — operator's view axis (Color, Size, …) translated into `variantGroupKey/Value` on ListingImage
- **Cascade** — 9-level resolution from variant-specific → group → product-level, each at marketplace → all-Amazon → global scope
- **Effective URL** (IE.6) — at publish time, prefer `master.url` over `listingImage.url` when the row links to a master. Lets master swaps propagate without per-row backfill.
- **Receipt** (IA.3) — per-SKU outcome from Amazon's processing report, stored on `AmazonImageFeedJob.resultSummary.perSku`
- **Stale** (IA.5) — `master.updatedAt > listingImage.publishedAt` on a row with `publishStatus='PUBLISHED'`

---

Source files in the repo:
- Resolver + publisher: `apps/api/src/services/images/amazon-image-feed.service.ts`
- Preview: `apps/api/src/services/images/amazon-image-preview.service.ts`
- Validator: `apps/api/src/services/images/amazon-publish-validator.service.ts`
- Stale detector: `apps/api/src/services/images/amazon-stale.service.ts`
- ZIP exporter: `apps/api/src/services/images/amazon-image-zip.service.ts`
- Routes: `apps/api/src/routes/images/amazon-images.routes.ts` + `channel-image-publish.routes.ts`
- FE images workspace: `apps/web/src/app/products/[id]/edit/tabs/images/`

# P4 — upload, compare, review & publish, Amazon ZIPs (slice plan)

Written 2026-09-28 after P3 went live. Design: [PLAN.md](PLAN.md) §4.3, §4.6, §5.5, §5.6, §7.1 (approved). This file
orders the work and records what the code study found. The Owner, 2026-09-28: "go with your recommendations and
complete whatever is left … AAA quality", and moved the Amazon ZIP from P5 into P4.

## Summary
- Four slices, one PR each, in this order: **P4a Compare** · **P4b Upload dialog** · **P4c Review & publish photos**
  · **P4d Amazon ZIPs**.
- **Found (P4c):** today one off-list value on ANY field blocks every eBay send, even a photos-only one
  (`studio-publication-plan.ts:70-74` turns every resolver cell error into a blocking issue; the preview then saves no
  review). GALE-JACKET's eBay IT listings hold "Tutte le stagioni" where eBay's list says "Tutte le stagione", so its
  photos cannot be sent. P4c makes a photos-only publish block only on what it sends (the photo plan's checks and the
  channel's picture rules). Content publishes keep today's rule.
- **Found (P4d):** the ASIN is not in `GET /media`; the ZIP needs it per SKU and market (`ChannelListing
  .externalListingId || platformProductId`, as the Amazon workspace reads it).
- Every slice is checked on the local throwaway stack (no worker, no scheduler) in light and dark, at 390 px and on a
  desktop, and by keyboard. Nothing reaches a channel from this machine.

## P4a — Compare (PLAN §4.3)
- Toolbar **Compare** (disabled below two destinations). A dialog with one chip per destination (the open destination
  and the others of its channel are ticked first, else the first three). Each set is one block; each chosen destination
  one line: where the set's photos come from, how many, and the photos in position order.
- Every line is compared with the **first destination that uses the set**: extra photos are outlined ("not in …" in
  the tooltip), missing ones are named ("Lacks …"), the same photos in another order say "Other order". A photo's
  language versions count as one photo (D6); each line shows the version its market sees.
- Safety applies to Amazon only; per-SKU sets to Amazon and Shopify, and appear only when a chosen destination has one.
- Pure model `compareDestinations` in `plan-page/model.ts` (tested); dialog `plan-page/CompareDialog.tsx`.

## P4b — Upload dialog (PLAN §4.6, §5.5)
- Drop files on the page, a set, or press **Upload photos**: one dialog (the PSIE pattern). Rows: preview, file, Set,
  Position, Language, Status. "Put them in: Shared / one channel / one listing".
- File names are read with the shared `parseMediaFileName` + `versionGroups` (P1). Values: the family's option labels.
- Files upload one at a time to the existing `POST /products/:id/images` (its duplicate check stays the gate):
  200 `reused:'exact'` → "Already in the library" (the existing photo is placed); 409 `NEAR_DUPLICATE` → "Looks like
  <photo>" with **Use that photo** (default) or **Upload anyway** (`force=true`).
- **New write:** a photo's language and version group (`ProductImage.languageTag`, `versionGroupId`) — no endpoint
  writes them today. `PATCH /products/:id/media/library` `{ updates: [{ id, languageTag, versionGroupId }] }`,
  permission `products.images.edit`, ids must belong to the family, event `product.media.changed` (reason `library`).
- **Place** = one ops call per layer: each set gets its photos at their positions (a version group is placed once —
  its main-language file; the others are versions). Photos already in a set are skipped, not refused.
- Done: "18 files placed (16 new in the library). 6 destinations follow them. Nothing was sent to a channel." with
  **Undo** (the ops answer's undo) and **Review & publish**. **Cancel** after uploading removes the photos this dialog
  added (never a reused one).
- Exit check (PLAN §9): 18 files incl. a size chart in 4 languages → 6 destinations in under 10 clicks.

## P4c — Review & publish photos (PLAN §5.6, §6.3)
- `POST /products/:id/media/publish/preview { destinations[] }` → per destination: what would change (from the
  channel's own review: eBay `GetItem` picture rows; Amazon slot diffs), checks, ready / fix first.
  `POST …/publish/submit { previewId, destinations[] }` → sends; `GET …/publish/:id` → progress.
- **Photos only.** eBay: the studio publication review, selecting only `pictures` and `Pictures` (Trading) or
  `pictures` and `variationPictures` (Inventory); a photos-only review blocks only on the photo plan's checks and the
  picture rules, never on another field's value. A picture that already matches is "no change". Amazon: the existing
  media run (image attributes only), one run per account through one listed market. Shopify: a photo change there is a
  whole-product push today → listed as "photos go with the next Shopify publish", not sent here. Etsy: P5.
- Sent → Accepted → checked on the channel (eBay read-back; Amazon run receipts), or Failed with the channel's reason
  and Retry. Permission: `products.publish`.
- The first real send stays one listing, with the Owner's word per send.

## P4d — Amazon ZIPs (PLAN §7.1, moved from P5)
- `GET /media` carries each Amazon SKU's ASIN per market.
- Shared pure `planAmazonArchive({ kind: 'slots' | 'safety' | 'country', market, … })`: file names `ASIN.SLOT.jpg`,
  slot allow-list (MAIN, PT01–08, SWCH, PS01–06), 1,000-file cap, blocked items with reasons; a country ZIP holds only
  that market's language versions.
- One archive service on the studio safety-export engine (safe fetcher, 4 at a time, real JPEG, all-or-nothing, revision
  checked before and after), route `POST /products/:id/media/amazon-archive`.
- In the Amazon channel view: **Export ZIP for Seller Central ▾** (per market: all slots, safety images, country
  photos) with a preview of the files and the exact Seller Central tool to use.
